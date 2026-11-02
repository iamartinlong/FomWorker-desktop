/**
 * 蒸馏进程的挂载入口（设计 §3.5 DM7 双进程，§7 第 6 步 A2）。
 *
 * 存在的理由只有一条技术事实：`--patch` 的装载取模块**默认导出**
 * （`vendor/loader/src/index.ts:203` `unwrapExports`），而蒸馏角色需要的 `inject`
 * 比成员角色多三个必需服务（storageDomain / schedule / sessions）—— 同一模块的默认导出
 * 只能是一份描述符，所以角色靠入口文件分。成员部署继续指 `./plugins/office-memory/index.ts`。
 *
 * patch 行（蒸馏进程，`memoryRoot` 同时就是它的 `workspaceRoot`，DM7）：
 *   - insert:
 *       - id: office-memory
 *         name: ./plugins/office-memory/distiller.ts
 *         config:
 *           memoryRoot: '<记忆目录绝对路径>'
 *           distiller: true
 *
 * `distiller: true` 与这份描述符必须成对出现：描述符保证服务齐备，config 保证 `apply`
 * 接蒸馏那半边线；错配在 `apply` 开头响亮地抛，不会静默装出半个蒸馏进程。
 */

import { OfficeMemoryDistiller } from './index.ts'

export default OfficeMemoryDistiller
