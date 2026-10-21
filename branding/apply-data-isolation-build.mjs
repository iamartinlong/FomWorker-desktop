/**
 * 在 `package-target.ts` 的 **`build:official` 之后、`release:pack` 之前**插一步：
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
 * ⇒ 只能插在**全仓构建完成之后、产物打包（`release:pack` 收集 343 个 tarball）之前**。
 *    这样重建出的 `lib/main.js` 会被 `release:pack` 收进 tarball。
 *
 * 用法（桌面仓根）：node branding/apply-data-isolation-build.mjs [内核目录=deepseek-harness]
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const kernelRoot = resolve(process.argv[2] ?? 'deepseek-harness')
const packageTarget = join(kernelRoot, 'apps', 'desktop', 'scripts', 'package-target.ts')

/** 锚点：全仓构建之后的第一条命令（`release:pack`）。 */
const ANCHOR = "  await execute(['run', 'release:pack', '--family', 'dsh', '--out', buildPaths.packedDsh, ...packArguments], buildEnv, REPOSITORY_ROOT)"

/** 注入：串行重建 desktop 的 bundle（此时 lib/ 已齐），并校验注入生效。 */
const INJECTION = `  await execute(['--filter', '@deepseek-ai/dsh-desktop', 'run', 'bundle'], buildEnv, REPOSITORY_ROOT)
  // 断言数据隔离注入确实进了桌面主进程产物。\`build:official\` 的 run-gates 是并发的，
  // Desktop bundle 可能在 lib/types 尚未生成时执行 ⇒ 这里必须重跑一次并验证。
  {
    const bundledMain = readFileSync(join(REPOSITORY_ROOT, 'apps', 'desktop', 'lib', 'main.js'), 'utf8')
    if (!bundledMain.includes('fomworkerHome')) {
      throw new Error('data isolation: apps/desktop/lib/main.js 缺少 fomworkerHome —— 注入没进产物，拒绝打包')
    }
    console.log('data isolation: verified apps/desktop/lib/main.js contains fomworkerHome')
  }
`

const source = await readFile(packageTarget, 'utf8')

if (source.includes('缺少 fomworkerHome')) {
  console.log('data isolation build hook: already applied, skipping')
  process.exit(0)
}

if (!source.includes(ANCHOR)) {
  throw new Error(`data isolation build hook: anchor not found in ${packageTarget}`)
}

const patched = source.replace(ANCHOR, `${INJECTION}${ANCHOR}`)

// `readFileSync` 已由 package-target.ts 自己导入（第 2 行），无需补。

await writeFile(packageTarget, patched)
console.log(`data isolation build hook: rebuild+verify desktop bundle before release:pack (patched ${packageTarget})`)
