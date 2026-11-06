/**
 * 把内核 **`ctx.pluginManager`** 适配成控制台的 `InstallerPort`（M2/D）。
 *
 * ⚠️ **装插件＝进程内、工作区沙箱外执行**（`安全与数据治理设计` S5）⇒ 真装**必须显式开启**
 * （`office-console` 的 `Config.enableInstaller`，默认 `false`）。未开启时 executor 无 installer ⇒ `dry-run`（不真装）。
 *
 * 用**结构化**类型（只取 `installBundle`/`removeBundle`），不依赖内核包类型导出（junction 里没有 plugin-manager）。
 */

import type { InstallerPort } from './executor.ts'
import type { ConnectorInstaller } from './connector-service.ts'

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

/**
 * 造**用户自建连接器**的装卸口（T5a）——与 `createPluginManagerInstaller` 同一个 `pm`、
 * 同一道 `enableInstaller` 闸，**不发明第二个开关**。
 *
 * 与上面那件的差别只在签名语义：连接器装卸传的是**包名**（`@local/<slug>`），
 * 而 `InstallerPort` 那对传的是 spec 串。内核侧 `installBundle(spec)` / `removeBundle(name)`
 * 自己会 `loadOverlayPatches` + `selectBundle` + `publishAndReload`（详案 §6.2）。
 * @param pm - `pluginManager` 服务（结构化）。
 * @returns `ConnectorInstaller`。
 */
export function createConnectorInstaller(pm: PluginManagerLike): ConnectorInstaller {
  return {
    installBundle: (spec) => pm.installBundle(spec),
    removeBundle: (name) => pm.removeBundle(name),
  }
}
