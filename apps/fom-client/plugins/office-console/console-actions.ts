/**
 * 控制台**写端点**：处理函数（Fetch 形态）+ 执行桩（M2/D）。
 *
 * 传输用内核的 **`ctx.connection.fetch.register`** —— 在**共享 `/api` 通道**上注册一条**已通过信任 + 鉴权策略**
 * 的 exact Fetch 路由（`packages/client/connection/src/rpc-host.ts:108-114`：*"A request that passes the fence and
 * authentication speaks for the operator"*）。这是「写操作必须已认证」的正规做法，**不用**无鉴权的 `webServer` 路由。
 *
 * ⭐ **安全取向（两个洞都堵上）**：
 * - **`role` 由服务端决定**（调用方传入 `operatorRole`，来自 `office-console` 的 `Config`），**不读客户端 `role`**——
 *   否则客户端可自称 owner（KE1）。
 * - **`approved` 由服务端决定**（当前恒 `false`：审批流程未接前高危一律 `202`），**不读客户端批准位**（KE3）。
 *
 * 组合：`runConsoleAction`（三重防护决策）→ 仅当「允许且已批准」才调 `execute`。
 * HTTP 映射：`done→200`、`needs-approval→202`、`forbidden→403`、坏输入→`400`、非 POST→`405`。
 *
 * 依据：`docs/02-设计/控制台写操作权限设计v0.1.md`、`路由与权限模型设计v0.1.md`。
 */

import { OFFICE_ACTIONS, type OfficeAction, type OfficeRole } from '../office-authz/roles.ts'
import { runConsoleAction } from '../office-authz/actions.ts'
import type { OfficeAuthz } from '../office-authz/index.ts'
import type { ApprovalStore } from './approvals.ts'

/** 写端点的**完整 pathname**（含 `/api`）。内核按 `url.pathname` 精确匹配 fetch 路由，客户端 `POST /api/office/console/action`。 */
export const WRITE_ROUTE = '/api/office/console/action'

/** 已校验的写输入（**不含 `role`/`approved`**——两者都由服务端决定）。`approvalId`＝服务端签发的审批 id。 */
export interface WriteInput {
  readonly action: OfficeAction
  readonly payload: unknown
  readonly approvalId?: string
}

/** 执行体：只在（授权 + 已批准）后调用。 */
export type ConsoleActionExecutor = (action: OfficeAction, payload: unknown) => unknown | Promise<unknown>

/** 回显执行桩（dev/测试用；**不产生真实副作用**）。 */
export function createEchoExecutor(): ConsoleActionExecutor {
  return (action, payload) => ({ echoed: { action, payload } })
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
}

/**
 * 校验写输入对象：只认 `action`（须已登记）。`role`/`approved` **不在此**（服务端决定）。
 * @param body - 解析后的 JSON。
 * @returns 合法输入；否则 `undefined`。
 */
export function parseWriteInput(body: unknown): WriteInput | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  const action = record.action
  if (typeof action !== 'string' || !(OFFICE_ACTIONS as readonly string[]).includes(action)) return undefined
  return { action: action as OfficeAction, payload: record.payload, ...(typeof record.approvalId === 'string' ? { approvalId: record.approvalId } : {}) }
}

/**
 * 造写端点的 Fetch 处理函数（与传输接线拆开，便于单测）。
 * @param authz - 授权服务。
 * @param execute - 执行体（仅授权 + 批准后调用）。
 * @param operatorRole - **服务端**认定的调用者角色（不读客户端）。
 * @returns 处理函数。
 */
export function createWriteFetch(
  authz: OfficeAuthz,
  execute: ConsoleActionExecutor,
  operatorRole: OfficeRole,
  approvals: ApprovalStore,
): (request: Request) => Promise<Response> {
  return async (request) => {
    void authz
    if (request.method !== 'POST') return jsonResponse(405, { code: 'method-not-allowed' })
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonResponse(400, { code: 'invalid-json' })
    }
    const input = parseWriteInput(body)
    if (input === undefined) {
      return jsonResponse(400, { code: 'invalid-input', actions: OFFICE_ACTIONS })
    }
    // 批准由**服务端**产生：仅当携带有效（已 grant 且摘要一致）的审批 id 才视作已批准并一次性消费。
    const approved = input.approvalId !== undefined && approvals.consume(input.approvalId, input.action, input.payload)
    let result
    try {
      result = await runConsoleAction({ role: operatorRole, action: input.action, approved }, () => execute(input.action, input.payload))
    } catch (error) {
      // **输入类**错误（缺字段 / 非法值 / 目标不存在）→ **400**（判别看 `code`，不看 `instanceof`）；其余 → 500。
      const code = (error as { code?: unknown } | null)?.code
      if (code === 'invalid-input') {
        return jsonResponse(400, { code: 'invalid-input', message: error instanceof Error ? error.message : String(error) })
      }
      return jsonResponse(500, { code: 'execution-failed', message: error instanceof Error ? error.message : String(error) })
    }
    if (result.status === 'done') return jsonResponse(200, result)
    if (result.status === 'forbidden') return jsonResponse(403, result)
    // needs-approval：产生（或复用）一条 pending 审批，把 id 交回，待审批人 grant 后带 id 重试。
    const record = approvals.request(input.action, input.payload)
    return jsonResponse(202, { status: 'needs-approval', approvalId: record.id })
  }
}
