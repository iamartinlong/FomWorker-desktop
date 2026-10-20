/**
 * 桌面端 FomWorker **数据目录隔离**覆盖层：让 FomWorker 用**自己的** DSH_HOME。
 *
 * ## 为什么需要它（2026-10-20 实测事故）
 *
 * 内核 `resolveDshHome()` 的取值顺序是「显式配置 > `$DSH_HOME` > `~/.dsh`」，而
 * `apps/desktop/src/paths.ts` 直接 `resolveDesktopPaths(resolveDshHome())`
 * ⇒ 打包版没设 `DSH_HOME` 时**与官方版共用 `~/.dsh`**。
 *
 * 而 `project-manager.ts` 的 `initProfile()` **只在 `package.json` 不存在时才写**
 * ⇒ 机器上装过官方版（已有 `~/.dsh/profiles/desktop/package.json`）时，
 * 我们的 `@fominfo/dsh-bundle-fomworker` **永远进不了 bundles**。
 * 症状：装的是 FomWorker，界面却完全是官方版（官方品牌 + 官方账号 + 官方工作区）。
 *
 * ## 为什么改 `paths.ts` 而不是 `main.ts`
 *
 * 先试过往 `main.ts` 顶部插 `process.env.DSH_HOME = ...`，**行不通**：
 *   1. ESM 的 `import` 声明会被提升到模块顶部；插在 import 之间的语句执行顺序
 *      不可靠，而且 `app.getPath('userData')` 在 app 未 ready 时拿到的不是最终值；
 *   2. 该文件里 `app` 的求值点分散在多个函数中，没有单一可靠的注入锚点。
 *
 * `paths.ts` 是**唯一**把 `resolveDshHome()` 变成桌面路径的地方，且
 * `resolveDesktopPaths()` 在 `app.whenReady()` 之后才被调用 ⇒ 那里求
 * `app.getPath('userData')` 是安全的。
 *
 * ## 效果

 * profile / sessions / credentials / logs 全部落在 `<userData>/dsh-home`：
 *   1. 与官方版并存互不干扰，任一方升级 bundles 都不影响另一方；
 *   2. 子进程（desktop host）经 `desktopNodeEnvironment(...)` 继承 `process.env`
 *      ⇒ 只要把结果写进 `process.env.DSH_HOME`，整条链路都跟着走。
 *
 * ## ⚠️ 改完必须重建 desktop 的 **bundle** 产物（不能只改源码）
 *
 * 桌面主进程的产物是 `apps/desktop/lib/main.js`（tsdown 打包，498 KB），它的入口是
 * `lib/types/main.js`（`tsc -b` 的产物），而 `lib/types/*.js` 才是 `src/*.ts` 的编译结果。
 * 三层链路：`src/paths.ts` → `lib/types/paths.js` → `lib/main.js`（bundle 内联）。
 *
 * 2026-10-20 CI 实测：`pkg-8` 的 `build:official` 跑了 `tsc -b tsconfig.host.json`（重编了
 * `lib/types/paths.js`），但**产物里仍然没有注入**。根因是根 `tsdown.config.ts` 显式说明
 * 「tsdown builds workspace members **concurrently** without ordering」——桌面 bundle 与
 * 工作区包并发，可能拿到尚未重编的 `lib/types`。同理，`pnpm install` 的 postinstall 也会
 * 在 overlay 之前先跑一次 desktop bundle。
 *
 * ⇒ 因此本脚本在改完源码后**自己把链路走完**：
 *   `tsc -b apps/desktop/tsconfig.host.json --force` → `pnpm --filter @deepseek-ai/dsh-desktop run bundle`
 * 并且**校验产物里真的有 `fomworkerHome`**，没有就响亮失败（绝不静默出一个「看起来正常、
 * 其实没生效」的安装器）。
 *
 * 幂等：已显式指定 `DSH_HOME`（开发调试）时不覆盖。
 *
 * 用法（桌面仓根）：node branding/apply-data-isolation.mjs [内核目录=deepseek-harness]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const kernelRoot = resolve(process.argv[2] ?? 'deepseek-harness')
const pathsPath = join(kernelRoot, 'apps', 'desktop', 'src', 'paths.ts')

/** 原实现（连同它自己的 JSDoc，避免注释挂错对象）。 */
const ANCHOR = `/**
 * Resolve every Electron-owned path without changing the shared data roots.
 * @param dshHome - Harness home shared with npm-installed dsh.
 * @returns immutable desktop path set.
 */
export function resolveDesktopPaths(dshHome: string = resolveDshHome()): DesktopPaths {`

/** 隔离实现：默认参数改成「先确保 DSH_HOME 指向 FomWorker 自己的目录」。 */
const REPLACEMENT = `/**
 * FomWorker 专属的 Harness home（见 branding/apply-data-isolation.mjs）。
 *
 * 在**第一次**解析桌面路径时把 \`process.env.DSH_HOME\` 钉到
 * \`<userData>/dsh-home\`，之后内核与所有子进程都按它走。
 *
 * 为什么要钉而不是传参：\`resolveDshHome()\` 在 profile 加载、凭据库、会话存储、
 * 附件缓存等**十几处**被独立调用，逐处传参既不可能也不可靠（任何一处漏传就
 * 会把数据写回 \`~/.dsh\`，与官方版混在一起）。环境变量是内核自己的既有通道。
 * @returns 隔离后的 Harness home 绝对路径。
 */
function fomworkerHome(): string {
  const current = process.env.DSH_HOME
  if (current === undefined || current.trim() === '') {
    // \`app.getPath('userData')\` 在此处已可用：调用方都在 app ready 之后。
    process.env.DSH_HOME = join(app.getPath('userData'), 'dsh-home')
  }
  return resolveDshHome()
}

/**
 * Resolve every Electron-owned path without changing the shared data roots.
 * @param dshHome - Harness home shared with npm-installed dsh.
 * @returns immutable desktop path set.
 */
export function resolveDesktopPaths(dshHome: string = fomworkerHome()): DesktopPaths {`

const source = await readFile(pathsPath, 'utf8')

const alreadyApplied = source.includes('function fomworkerHome()')
if (!alreadyApplied) {
  if (!source.includes(ANCHOR)) {
    throw new Error(`data isolation: anchor not found in ${pathsPath}`)
  }

  const patched = source
    .replace(ANCHOR, REPLACEMENT)
    // 该文件原来只 import 了 `join`，隔离实现要用 `app`，补齐导入。
    .replace(
      "import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'",
      "import { app } from 'electron'\nimport { resolveDshHome } from '@deepseek-ai/dsh-home-paths'",
    )

  if (!patched.includes("import { app } from 'electron'")) {
    throw new Error('data isolation: electron import anchor not found')
  }

  await writeFile(pathsPath, patched)
  console.log(`data isolation: DSH_HOME → <userData>/dsh-home (patched ${pathsPath})`)
} else {
  // ⚠️ **不能直接跳过**：源码已在只说明「打过一次补丁」，不说明**产物是新的**。
  // CI 上恰恰是这种情况——同步过来的源码已含补丁，但 `lib/types` / `lib/main.js` 是
  // 构建期用旧源码产出的（见文件头「改完必须重建」）。所以仍要走重建 + 校验。
  console.log('data isolation: source already patched, re-verifying build outputs')
}

// ── 重建产物并校验（关键：不做这一步，改动只停在源码层，安装器里没有）──────────
//
// 见文件头「改完必须重建 desktop 的 bundle 产物」。这两步与 `build:lib:host` 做的事
// 相同，但**串行且紧跟在写文件之后**，不与工作区构建并发抢时序。
const desktopRoot = join(kernelRoot, 'apps', 'desktop')
const bundleEntry = join(desktopRoot, 'lib', 'main.js')

const run = (command, args, cwd) => {
  // ⚠️ 不用 `shell: true`：内核根路径含空格（`F:\deepseek\deepseek harness\`），
  // 交给 shell 拼接会把它拆成两个参数（实测 `Cannot find module 'F:\deepseek\deepseek'`）。
  execFileSync(command, args, { cwd, stdio: 'inherit' })
}

/** Windows 上 `pnpm` 是 `.cmd`，`execFileSync` 直接调不动 ⇒ 走 `cmd /c` 并显式加引号。 */
const runPnpm = (args, cwd) => {
  if (process.platform === 'win32') {
    execFileSync('cmd', ['/c', 'pnpm', ...args], { cwd, stdio: 'inherit' })
  } else {
    execFileSync('pnpm', args, { cwd, stdio: 'inherit' })
  }
}

console.log('data isolation: rebuilding apps/desktop lib/types + bundle …')
run(process.execPath, [
  join(kernelRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
  '-b', join(desktopRoot, 'tsconfig.host.json'), '--force', '--pretty', 'false',
], kernelRoot)
runPnpm(['--filter', '@deepseek-ai/dsh-desktop', 'run', 'bundle'], kernelRoot)

// 产物断言：宁可在这里响亮失败，也不要出一个「看起来正常、其实没生效」的安装器。
const bundled = readFileSync(bundleEntry, 'utf8')
if (!bundled.includes('fomworkerHome')) {
  throw new Error(
    `data isolation: ${bundleEntry} 里找不到 fomworkerHome ⇒ 注入没进产物。`
    + '检查 apps/desktop 的 tsc/bundle 链是否跑通（CI 上曾因并发构建拿到旧的 lib/types 而静默失败）。',
  )
}
console.log(`data isolation: verified ${bundleEntry} contains fomworkerHome`)
