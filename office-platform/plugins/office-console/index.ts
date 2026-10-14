/**
 * `office-console` 的 host 面（最小只读 L1 界面的数据通道）。
 *
 * 浏览器端（同目录 `client.js`）渲染一个 `main` 面板 + 侧栏入口；数据从这条**只读**路由取——
 * `GET /office/catalog` 返回 L0 默认能力目录（P0 的 `officeCatalog` 服务）。路由经内核
 * `ctx.webServer.register` 挂载（形状抄审批层回调路由），**不在 dsh 的 `/api` token 守卫内**
 * （与 `/office/approval/callback` 同理）；本路由只吐**非机密**的目录元数据，不含凭据。
 *
 * 为什么要 host 路由而不是把数据抄进 `client.js`：**单一真相源**——目录只在 `office-catalog/catalog.ts`
 * 一处；将来 L1 的安装/启停动作会走真正的 Remote，这条路由是「host→client 数据流」的第一步。
 *
 * `inject:['officeCatalog']` ⇒ 本插件依赖 P0 的目录服务；服务不在（没挂 `office-catalog`）就不装，
 * 界面也就没有数据来源（这是装配错误，不是放宽）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'
import type { OfficeCatalog } from '../office-catalog/catalog.ts'
import type { OfficeAuthz } from '../office-authz/index.ts'
import { OFFICE_ROLES, type OfficeRole } from '../office-authz/roles.ts'
import { ACTIONS_ROUTE, createActionsHandler } from './actions-route.ts'
import { WRITE_ROUTE, createWriteFetch } from './console-actions.ts'
import { createCapabilityStore, createConsoleExecutor } from './executor.ts'
import { createApprovalStore } from './approvals.ts'
import { createPluginManagerInstaller, type PluginManagerLike } from './installer.ts'
import { STATE_ROUTE, createStateHandler } from './state-route.ts'

export * from './actions-route.ts'
export * from './console-actions.ts'
export * from './executor.ts'
export * from './approvals.ts'
export * from './installer.ts'
export * from './state-route.ts'

/** `webServer` 服务的最小面：只要 `register`，不依赖内核包的类型导出。 */
interface WebServerLike {
  register: (route: {
    kind: 'exact'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }) => () => void
}

/** `connection` 服务的最小面（认证 Fetch 路由）：只取 `fetch.register`，不依赖内核包类型导出。 */
interface ConnectionLike {
  fetch: {
    register: (route: {
      path: string
      methods: readonly string[]
      requestBody: 'buffered' | 'streaming'
      fetch: (request: Request) => Promise<Response>
    }) => () => Promise<void>
  }
}

/** 只读目录路由的路径。 */
export const CATALOG_ROUTE = '/office/catalog'

/**
 * 造只读目录路由的处理函数（与接线拆开，便于单测直接调，不必起 cordis/webServer）。
 * @param catalog - L0 默认能力目录服务。
 * @returns `IncomingMessage`/`ServerResponse` 处理函数：`GET` 返回 `{ version, entries }`，其余方法 405。
 */
export function createCatalogHandler(
  catalog: OfficeCatalog,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: 'method-not-allowed' }))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ version: catalog.version, entries: catalog.list() }))
  }
}

export const name = 'office-console'
export const inject = ['officeCatalog', 'officeAuthz']

/** 配置：**服务端**认定的操作者角色（不读客户端）+ 是否真接 pluginManager 安装。 */
export interface OfficeConsoleConfig {
  operatorRole: string
  /** 真装/卸载开关（默认 false：走 dry-run。装插件＝root 等价，须显式开启）。 */
  enableInstaller?: boolean
}
export const Config: z<OfficeConsoleConfig> = z.object({
  operatorRole: z.string().default('owner'),
  enableInstaller: z.boolean().default(false),
})

/**
 * 把只读路由（目录 + 动作决策 + 状态）挂到 `webServer`、写路由挂到认证的 `connection` 通道。
 * 服务不在（CLI 形态）就不挂——不影响产品其余部分。
 * @param ctx - 插件上下文。
 * @param config - 配置（`operatorRole`）。
 */
export function apply(ctx: Context, config: OfficeConsoleConfig): void {
  const operatorRole = config.operatorRole
  if (!(OFFICE_ROLES as readonly string[]).includes(operatorRole)) {
    throw new Error(`office-console: operatorRole 非法（须为 ${OFFICE_ROLES.join('/')}）：${operatorRole}`)
  }
  const catalog = ctx.get('officeCatalog')
  if (catalog === undefined) {
    throw new Error('office-console: officeCatalog 服务缺失（需与 office-catalog 一起挂）')
  }
  const authz = ctx.get('officeAuthz')
  if (authz === undefined) {
    throw new Error('office-console: officeAuthz 服务缺失（需与 office-authz 一起挂）')
  }
  // 能力启用态存储（种子来自目录的 defaultEnabled）+ 真实执行体（install/remove 未注入 installer 则 dry-run）。
  const store = createCapabilityStore(catalog.list().map((entry) => ({ id: entry.id, enabled: entry.defaultEnabled })))
  const approvals = createApprovalStore()
  const installer = config.enableInstaller === true
    ? createPluginManagerInstaller((() => {
        const pm = ctx.get('pluginManager') as PluginManagerLike | undefined
        if (pm === undefined) throw new Error('office-console: enableInstaller 已开但 pluginManager 服务缺失')
        return pm
      })())
    : undefined
  const executor = createConsoleExecutor({ store, approvals, ...(installer !== undefined ? { installer } : {}) })
  // `webServer` 在本插件的 apply 时刻还没有（实测），所以经 `ctx.inject` 等它就位再挂路由
  // （与内核 `ClientModuleRegistry` 的 `ctx.inject(['webServer'], …)` 同款）；CLI 形态下它的 fiber 一直不激活，就不挂。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const server = webCtx.get('webServer') as WebServerLike | undefined
      if (server === undefined) return () => {}
      const unregisterCatalog = server.register({ kind: 'exact', path: CATALOG_ROUTE, handler: createCatalogHandler(catalog) })
      const unregisterActions = server.register({ kind: 'exact', path: ACTIONS_ROUTE, handler: createActionsHandler(authz) })
      const unregisterState = server.register({ kind: 'exact', path: STATE_ROUTE, handler: createStateHandler(store, operatorRole as OfficeRole) })
      return () => {
        unregisterState()
        unregisterActions()
        unregisterCatalog()
      }
    }, 'office-console: 只读路由（目录 + 动作决策 + 状态）')
  })
  // 写操作走**认证的共享 `/api` Fetch 路由**（`connection.fetch.register`），**不**用无鉴权的 `webServer` 路由。
  // CLI/无 connection 形态下不注册（没有认证就没有写入口）。
  ctx.inject(['connection'], (connCtx) => {
    connCtx.effect(() => {
      const conn = connCtx.get('connection') as ConnectionLike | undefined
      if (conn === undefined) return () => {}
      const dispose = conn.fetch.register({
        path: WRITE_ROUTE,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: createWriteFetch(authz, executor, operatorRole as OfficeRole, approvals),
      })
      return () => { void dispose() }
    }, 'office-console: 写端点（认证 Fetch 路由）')
  })
}

export default { name, inject, Config, apply }
