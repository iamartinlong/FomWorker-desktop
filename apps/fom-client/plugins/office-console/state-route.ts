/**
 * `office-console` 的**状态读端点**：`GET /office/console/state` 返回各能力的启用态（`CapabilityStore`）。
 * 只吐**非机密**的启用位，供浏览器端展示「已启用/已禁用」。
 *
 * 传输用 `ctx.webServer`（只读，非机密）——与目录路由同源；写才走认证 Fetch 路由。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CapabilityStore } from './executor.ts'
import type { OfficeRole } from '../office-authz/roles.ts'

/** 状态读路由路径。 */
export const STATE_ROUTE = '/office/console/state'

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

/**
 * 造状态读端点的处理函数（与接线拆开，便于单测）。
 * @param store - 能力启用态存储。
 * @param operatorRole - **服务端**认定的操作者角色（前端据此渲染）。
 * @returns 处理函数：`GET` 返回 `{ operatorRole, capabilities }`；其余方法 405。
 */
export function createStateHandler(
  store: CapabilityStore,
  operatorRole: OfficeRole,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    if (request.method !== 'GET') {
      json(response, 405, { code: 'method-not-allowed' })
      return
    }
    json(response, 200, { operatorRole, capabilities: store.list() })
  }
}
