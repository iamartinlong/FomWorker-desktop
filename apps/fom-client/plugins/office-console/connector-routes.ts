/**
 * **用户自建连接器**的 HTTP 面（T5a）：`GET|POST /api/office/connector`。
 *
 * 路由形状（与 `console-actions.ts` 的 `WRITE_ROUTE` 同级——认证 `/api`，但**不并进
 * console action**：配置不是「动作」，且要返回表单 schema，详案 §3.3 明确建议独立端点）：
 *
 * - `GET  /api/office/connector?slug=<slug>` ⇒ `{ ok, slug, form, values, installed }`
 *   （`form` 是字段数组，`values` 是当前值；**敏感键值对已打码**）
 * - `POST /api/office/connector` body `{ op: 'create' | 'remove', ... }`
 *   · `create`：扁平的表单值（slug/name/description/transport/serverName/…）
 *   · `remove`：`{ op:'remove', slug }`
 *
 * **授权**：三个 op 全部复用 `connector.install` 那一票（owner/admin/member 均可、不需审批——
 * 见 `office-authz/roles.ts` 的矩阵）。理由：新建/删除就是装卸，配置是装卸的前置；
 * 为「配置」单开一票等于多一个要维护的权限位。角色由**服务端**决定（`operatorRole`），
 * 不读客户端——与 `createWriteFetch` 同一条安全取向。
 *
 * 传输用内核 `ctx.connection.fetch.register`（已通过信任 + 鉴权策略的共享 `/api` 通道），
 * 处理函数是 **Fetch 形态** `(request: Request) => Promise<Response>`——**不是** node-http 形态
 * （第一版写错了，被 `tsc` 当场抓出：`conn.fetch.register` 要的是前者）。
 */

import { OFFICE_ROLES, type OfficeAction, type OfficeRole } from '../office-authz/roles.ts'
import type { OfficeAuthz } from '../office-authz/index.ts'
import type { ConnectorService } from './connector-service.ts'

/** 用户自建连接器路由路径（含 `/api`）。 */
export const CONNECTOR_ROUTE = '/api/office/connector'

/**
 * 连接器三个 op 复用的授权动作。选 `connector.install` 而不是新开一票，理由见文件头。
 */
const CONNECTOR_ACTION: OfficeAction = 'connector.install'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
}

/** 读 `?slug=`（缺失 / 空 ⇒ `undefined`）。 */
function slugOf(request: Request): string | undefined {
  const value = new URL(request.url).searchParams.get('slug')
  return value !== null && value !== '' ? value : undefined
}

/**
 * 造连接器路由的 Fetch 处理函数（与接线拆开，便于单测直接调）。
 * @param authz - 授权服务。
 * @param operatorRole - **服务端**认定的调用者角色（不读客户端）。
 * @param connectors - 用户自建连接器服务。
 * @returns Fetch 形态处理函数。
 */
export function createConnectorFetch(
  authz: OfficeAuthz,
  operatorRole: OfficeRole,
  connectors: Pick<ConnectorService, 'create' | 'remove' | 'configOf' | 'configure' | 'createForm'>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (!(OFFICE_ROLES as readonly string[]).includes(operatorRole)) {
      return jsonResponse(500, { ok: false, error: `服务端角色非法：${operatorRole}` })
    }
    if (!authz.can(operatorRole, CONNECTOR_ACTION)) {
      return jsonResponse(403, { ok: false, error: '没有连接器配置权限' })
    }
    if (request.method === 'GET') {
      const url = new URL(request.url)
      // 新建表单：`?new=1[&transport=stdio|streamable-http]`——传输未定 ⇒ 先只给传输选择
      if (url.searchParams.get('new') === '1') {
        const transport = url.searchParams.get('transport') ?? undefined
        const { form, values } = connectors.createForm(transport)
        return jsonResponse(200, { ok: true, form, values })
      }
      const slug = slugOf(request)
      if (slug === undefined) return jsonResponse(400, { ok: false, error: '缺少 slug 参数' })
      const view = connectors.configOf(slug)
      if (view === undefined) return jsonResponse(404, { ok: false, error: `连接器不存在：${slug}` })
      return jsonResponse(200, { ok: true, ...view })
    }
    if (request.method !== 'POST') return jsonResponse(405, { ok: false, error: 'method-not-allowed' })

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonResponse(400, { ok: false, error: '请求体不是合法 JSON' })
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return jsonResponse(400, { ok: false, error: '请求体不是 JSON 对象' })
    }
    const record = body as Record<string, unknown>
    const op = typeof record.op === 'string' ? record.op : ''
    if (op === 'create') {
      // 服务端对扁平 body 做防御式读取（slug/name/description 都可空 ⇒ 由服务层报人话）
      const result = await connectors.create(record)
      return jsonResponse(result.ok ? 200 : 400, result)
    }
    if (op === 'remove') {
      const slug = typeof record.slug === 'string' ? record.slug : ''
      if (slug === '') return jsonResponse(400, { ok: false, error: '缺少 slug' })
      const result = await connectors.remove(slug)
      return jsonResponse(result.ok ? 200 : 400, result)
    }
    if (op === 'configure') {
      const id = typeof record.id === 'string' ? record.id : ''
      if (id === '') return jsonResponse(400, { ok: false, error: '缺少 id' })
      const { op: _op, id: _id, ...values } = record
      const result = await connectors.configure(id, values)
      return jsonResponse(result.ok ? 200 : 400, result)
    }
    return jsonResponse(400, { ok: false, error: `未知 op：${op}（应为 create / remove / configure）` })
  }
}
