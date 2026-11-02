/**
 * 把内核 **`ctx.pluginManager`** 适配成控制台的 `InstallerPort`（M2/D）。
 *
 * ⚠️ **装插件＝进程内、工作区沙箱外执行**（`安全与数据治理设计` S5）⇒ 真装**必须显式开启**
 * （`office-console` 的 `Config.enableInstaller`，默认 `false`）。未开启时 executor 无 installer ⇒ `dry-run`（不真装）。
 *
 * 用**结构化**类型（只取 `installBundle`/`removeBundle`），不依赖内核包类型导出（junction 里没有 plugin-manager）。
 */

import type { InstallerPort } from './executor.ts'

/** `pluginManager` 服务的最小面。 */
export interface PluginManagerLike {
  installBundle(spec: string, options?: unknown): Promise<unknown>
  removeBundle(spec: string, options?: unknown): Promise<unknown>
}

/**
 * 造 pluginManager 安装口。
 * @param pm - `pluginManager` 服务（结构化）。
 * @returns `InstallerPort`。
 */
export function createPluginManagerInstaller(pm: PluginManagerLike): InstallerPort {
  return {
    install: (spec) => pm.installBundle(spec),
    remove: (spec) => pm.removeBundle(spec),
  }
}
