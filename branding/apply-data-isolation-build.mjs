/**
 * 在 `package-target.ts` 的 **`build:official` 之后、产物打包之前**插一步：
 * 强制重建 `apps/desktop` 的 bundle，并断言产物里含数据隔离注入。
 *
 * ## 为什么必须插在这里（2026-10-20 CI 实测）
 *
 * 桌面主进程的产物链是三层：
 *
 *   `src/paths.ts` → `lib/types/paths.js`（`tsc -b`）→ `lib/main.js`（tsdown bundle）
 *
 * 而 `build:official` 内部的 `run-gates` 是**并发**跑的（日志实测 4 worker），
 * `Desktop bundle` 在 23:08:58 就执行了，而 `lib/types/paths.js` 到 23:11:43 才生成
 * ⇒ **bundle 拿到了旧/不全的 `lib/types`**，我们的注入没进 `main.js`。
 *
 * 这不能靠改 overlay 脚本自己重建解决——那时工作区依赖的 `lib/` 还没建齐
 * （pkg-9 实测：`RolldownError: imports @deepseek-ai/dsh-atomic-write …`）。
 *
 * ⇒ 只能插在**全仓构建完成之后、产物打包（`release:pack` 收集 tarball）之前**。
 *    这样重建出的 `lib/main.js` 会被打包步骤收进 tarball。
 *
 * ## ⚠️ 2026-10-24：锚点为什么从「`release:pack` 那一行」改成「`build:official` 之后」
 *
 * 第一版锚定 `await execute(['run', 'release:pack', '--family', 'dsh', '--out', …])` 这一行。
 * `pkg-24` / `pkg-25` 连续两轮 CI 都报 `anchor not found`，而本地始终能匹配。
 *
 * 真因：**CI 用 `git clone --depth 1 … master` 取内核，不锁版本**。上游在
 * `22ddee37`（PR #7075）把打包入口重构成了 `const pack = async () => { … }`，
 * 并且 **unsigned 构建改走 `pack-local-packages.ts`**、不再调用 `release:pack dsh`
 * ⇒ 那一行整行消失。
 *
 * 教训：**锚点不能选「某个具体命令的调用行」**——上游一重构就断。改成锚定
 * **语义稳定点**：`build:official` 之后的第一行。那个位置是阶段边界
 * （「全仓建完 → 开始收产物」），重构打包内部不会动它。
 *
 * ## ⚠️ 2026-10-24：为什么改成「唯一性断言 + 精确替换」
 *
 * 上一版是 `source.includes(ANCHOR)` 然后 `replace`。这类写法对输入形态做隐含假设：
 * 锚点不唯一时会**改错位置并继续写**，把内核树写坏（同日的 `apply-hero-copy.mjs`
 * 就是这么把 `locales.ts` 从 754 行写成 2750+ 行的）。
 *
 * ⇒ 现在：**先断言锚点恰好出现 1 次**，不满足就抛错并打印诊断，绝不硬改。
 *
 * 用法（桌面仓根）：node branding/apply-data-isolation-build.mjs [内核目录=deepseek-harness]
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const kernelRoot = resolve(process.argv[2] ?? 'deepseek-harness')
const packageTarget = join(kernelRoot, 'apps', 'desktop', 'scripts', 'package-target.ts')

/**
 * 语义锚点：跑「全仓构建」的那一行。
 *
 * 用**整行精确匹配**（包含判断），不用正则、不用行号 —— 上游增删执行器的参数
 * 就会让正则失配，而行号一定会漂。这里给两个已知形态：
 * 「三元式（新版）」与「直接调 build:official（旧版）」。
 *
 * 为什么不用「`release:pack` 那一行」：`22ddee37` 把打包入口重构成
 * `const pack = async () => {…}`，且 unsigned 分支改走 `pack-local-packages.ts`，
 * 那一行**整行消失**。锚点必须落在**阶段边界**（建完 → 收产物）而不是具体命令上。
 */
const ANCHOR_CANDIDATES = [
  // 新版（22ddee37 起）：三元式，unsigned 走 build --profile local。
  "await execute(invocation.unsigned ? ['run', 'build', '--profile', 'local'] : ['run', 'build:official'], buildEnv, REPOSITORY_ROOT)",
  // 旧版（5badb15009）：直接调 build:official。
  "await execute(['run', 'build:official'], buildEnv, REPOSITORY_ROOT)",
]

/**
 * 注入：串行重建 desktop 的 bundle（此时 `lib/` 已齐），并校验注入生效。
 *
 * 末尾**不留换行**：拼接时用 `anchor + '\n' + INJECTION`，让注入块紧贴锚点下方、
 * 之后接原文自己的换行，不多出空行。
 */
const INJECTION = `  await execute(['--filter', '@deepseek-ai/dsh-desktop', 'run', 'bundle'], buildEnv, REPOSITORY_ROOT)
  // 断言数据隔离注入确实进了桌面主进程产物。\`build:official\` 的 run-gates 是并发的，
  // Desktop bundle 可能在 lib/types 尚未生成时执行 ⇒ 这里必须重跑一次并验证。
  {
    const bundledMain = readFileSync(join(REPOSITORY_ROOT, 'apps', 'desktop', 'lib', 'main.js'), 'utf8')
    if (!bundledMain.includes('fomworkerHome')) {
      throw new Error('data isolation: apps/desktop/lib/main.js 缺少 fomworkerHome —— 注入没进产物，拒绝打包')
    }
    console.log('data isolation: verified apps/desktop/lib/main.js contains fomworkerHome')
  }`
/** 幂等判据：本脚本注入的独特标记。 */
const MARKER = '缺少 fomworkerHome'

/**
 * 断言某个子串在文本里恰好出现 `expected` 次，并把实际次数写进诊断。
 * @param text 被检查的文本。
 * @param needle 要计数的子串。
 * @param expected 期望出现次数。
 * @param label 诊断用的名字。
 */
function assertOccurrences(text, needle, expected, label) {
  const actual = text.split(needle).length - 1
  if (actual !== expected) {
    throw new Error(
      `data isolation build hook: ${label} 出现 ${String(actual)} 次，预期 ${String(expected)} 次。\\n`
      + `  锚点不唯一（或内核结构已变）时本脚本拒绝写文件 —— 硬改会把内核树写坏。\\n`
      + `  若内核确实改了构建阶段的写法，请更新 ANCHOR_CANDIDATES。\\n`
      + `  子串：${JSON.stringify(needle)}`,
    )
  }
}

const source = await readFile(packageTarget, 'utf8')

if (source.includes(MARKER)) {
  console.log('data isolation build hook: already applied, skipping')
  process.exit(0)
}

// 逐个候选锚点试：**必须恰好命中 1 个候选，且该候选在文件里恰好出现 1 次**。
const hits = ANCHOR_CANDIDATES.filter((anchor) => source.includes(anchor))

if (hits.length === 0) {
  // 一个都没命中 ⇒ 上游改了构建阶段入口。打印文件里所有 execute(...) 行，便于定位。
  const candidates = source.split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => line.includes("'build:official'") || line.includes("'build', '--profile'"))
    .map(({ line, number }) => `    行${String(number)}: ${line.trim()}`)
    .join('\n')
  throw new Error(
    `data isolation build hook: 找不到构建阶段锚点，文件 ${packageTarget}。\\n`
    + `  期望其中之一（各恰好 1 次）：\\n`
    + ANCHOR_CANDIDATES.map((anchor) => `    ${JSON.stringify(anchor)}`).join('\n')
    + `\\n  文件里与构建相关的行：\\n${candidates === '' ? '    (无)' : candidates}`,
  )
}

if (hits.length > 1) {
  throw new Error(
    `data isolation build hook: 有 ${String(hits.length)} 个候选锚点同时命中，无法确定注入点：\\n`
    + hits.map((anchor) => `    ${JSON.stringify(anchor)}`).join('\n'),
  )
}

const anchor = hits[0]
assertOccurrences(source, anchor, 1, '构建阶段锚点')

// ⚠️ 必须是 `anchor + injection`（**之后**），不能是 `injection + anchor`：
// 注入要做的是「在全仓构建建齐 `lib/` 之后重建 bundle」，
// 放到锚点之前就等于在 `build:official` 之前跑 —— 那时依赖还没建齐，
// 正是 pkg-9 撞过的 `RolldownError: imports @deepseek-ai/dsh-atomic-write`。
const patched = source.replace(anchor, `${anchor}\n${INJECTION}`)

// 写回前的**最后一道护栏**：把注入块原样挖掉必须**逐字节还原**原文。
// 比「数行数」更硬——任何越界替换、重复插入都会在这里暴露。
const inserted = `${anchor}\n${INJECTION}`
if (patched.split(inserted).length - 1 !== 1) {
  throw new Error('data isolation build hook: 注入块在结果里不唯一，拒绝写文件。')
}
if (patched.replace(inserted, anchor) !== source) {
  throw new Error('data isolation build hook: 挖掉注入块后无法还原原文 —— 替换越界，拒绝写文件。')
}

// `readFileSync` 已由 package-target.ts 自己导入（第 4 行），无需补。
await writeFile(packageTarget, patched)
console.log(`data isolation build hook: rebuild+verify desktop bundle before packaging (patched ${packageTarget})`)
