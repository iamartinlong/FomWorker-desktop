/**
 * `office-console` 的**按角色动作决策**读路由（M2/D）：`GET /office/console/actions?role=<role>` 返回
 * 该角色对每个控制台动作的 `{ allowed, requiresApproval }`——供浏览器端**按角色渲染**按钮的启用/置灰。
 *
 * 读的是 `officeAuthz`（A1 的授权矩阵）**单一真相源**，不在客户端抄一份矩阵。只吐**非机密**的授权元数据。
 * 依据：`docs/02-设计/控制台写操作权限设计v0.1.md` §2。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { OFFICE_ACTIONS, OFFICE_ROLES, type OfficeRole } from '../office-authz/roles.ts'
import type { OfficeAuthz } from '../office-authz/index.ts'

/** 动作决策路由路径。 */
export const ACTIONS_ROUTE = '/office/console/actions'

/** 一条动作决策。 */
export interface ActionDecision {
  readonly action: string
  readonly allowed: boolean
  readonly requiresApproval: boolean
}

/** 从 `?role=` 解析角色；缺失或非法返回 `undefined`。 */
export function parseRole(url: string | undefined): OfficeRole | undefined {
  const value = new URL(url ?? '/', 'http://localhost').searchParams.get('role')
  if (value === null) return undefined
  return (OFFICE_ROLES as readonly string[]).includes(value) ? (value as OfficeRole) : undefined
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

/**
 * 造动作决策路由的处理函数（与接线拆开，便于单测）。
 * `GET ?role=<已知角色>` → `{ role, decisions }`；缺/非法 role → 400；非 GET → 405。
 * @param authz - 授权服务。
 * @returns 处理函数。
 */
export function createActionsHandler(
  authz: OfficeAuthz,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    if (request.method !== 'GET') {
      json(response, 405, { code: 'method-not-allowed' })
      return
    }
    const role = parseRole(request.url)
    if (role === undefined) {
      json(response, 400, { code: 'role-required', roles: OFFICE_ROLES })
      return
    }
    const decisions: ActionDecision[] = OFFICE_ACTIONS.map((action) => ({
      action,
      allowed: authz.can(role, action),
      requiresApproval: authz.requiresApproval(action),
    }))
    json(response, 200, { role, decisions })
  }
}
