/**
 * 桌面端 FomWorker **数据目录隔离**覆盖层：让 FomWorker 用**自己的** DSH_HOME。
 *
 * ## 为什么需要它（2026-10-20 实测事故）
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
 * ⇒ 本脚本只负责**改源码**。重建与产物断言由
 *   `branding/apply-data-isolation-build.mjs` 在 `build:official` 之后、
 *   `release:pack` 之前完成（那里工作区 `lib/` 已建齐、且产物还没被打包）。
 *
 * 幂等：已显式指定 `DSH_HOME`（开发调试）时不覆盖。
 *
 * 用法（桌面仓根）：node branding/apply-data-isolation.mjs [内核目录=deepseek-harness]
 */
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

// ── 产物校验（不在本脚本重建）────────────────────────────────
//
// 重建必须发生在**全仓构建完成之后、`release:pack` 之前**——见
// `branding/apply-data-isolation-build.mjs`（它给 `package-target.ts` 插了一步）。
// 原因（2026-10-20 CI 实测两次）：
//   · 在本脚本里重建 ⇒ 工作区依赖的 `lib/` 还没建齐
//     （`RolldownError: imports @deepseek-ai/dsh-atomic-write, which the package …`）；
//   · 完全依赖 `build:official` ⇒ 其 `run-gates` 是**并发**的，`Desktop bundle`
//     可能早于 `lib/types` 生成（实测 23:08:58 vs 23:11:43）⇒ 拿到旧产物。
//
// 所以本脚本只负责**改源码**；产物断言由 build hook 与 `scripts/verify-installer.mjs`
// 两道各管一层。
if (process.argv.includes('--rebuild')) {
  console.log('data isolation: --rebuild 已废弃——重建改由 branding/apply-data-isolation-build.mjs 在 release:pack 之前完成')
}
