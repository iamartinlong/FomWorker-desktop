/**
 * 连接器路由的验收（T5a）。用**假服务 + 真 `Request`/`Response`** 直接调处理器——
 * 不起 cordis、不起 HTTP，只验「路由形状 + 状态码 + 授权 + 打码不泄漏」。
 */

import { describe, expect, it } from 'vitest'
import { CONNECTOR_ROUTE, createConnectorFetch } from './connector-routes.ts'
import type { ConnectorService } from './connector-service.ts'
import type { OfficeAuthz } from '../office-authz/index.ts'
import type { OfficeRole } from '../office-authz/roles.ts'

/** 记录调用的假服务。 */
function fakeService(overrides: Partial<ConnectorService> = {}): ConnectorService & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async create(input) { calls.push(`create:${String(input.slug)}`); return { ok: true, slug: String(input.slug), dryRun: true } },
    async remove(slug) { calls.push(`remove:${slug}`); return { ok: true, slug, removed: true } },
    configOf(slug) {
      calls.push(`config:${slug}`)
      return {
        slug,
        form: [{ key: 'serverName', label: '服务名', type: 'text', required: true }],
        values: { serverName: 'gh', headers: { Authorization: '••••••••' } },
        installed: false,
      }
    },
    async configure(id, values) { calls.push(`configure:${id}:${JSON.stringify(values)}`); return { ok: true, id, secretsWritten: [], restartRequired: true } },
    createForm(transport) { return { form: [], values: transport === undefined ? {} : { transport } } },
    list() { return [] },
    ...overrides,
  }
}

/** 全放行的授权（member 也能配——与 connector.install 矩阵一致）。 */
const allowAll: OfficeAuthz = { can: () => true, requiresApproval: () => false } as unknown as OfficeAuthz
const denyAll: OfficeAuthz = { can: () => false, requiresApproval: () => false } as unknown as OfficeAuthz

/** 发一个请求并读回状态码 + JSON。 */
async function call(
  authz: OfficeAuthz,
  role: OfficeRole,
  svc: ConnectorService,
  request: Request,
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const response = await createConnectorFetch(authz, role, svc)(request)
  const text = await response.text()
  return { status: response.status, body: JSON.parse(text) as Record<string, unknown>, text }
}

const get = (slug?: string): Request => new Request(`http://localhost${CONNECTOR_ROUTE}${slug === undefined ? '' : `?slug=${slug}`}`)
const post = (body: unknown): Request => new Request(`http://localhost${CONNECTOR_ROUTE}`, {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
})

describe('connector-routes', () => {
  it('路由常量是 /api/office/connector（与 WRITE_ROUTE 同级但独立）', () => {
    expect(CONNECTOR_ROUTE).toBe('/api/office/connector')
  })

  it('GET 缺 slug ⇒ 400，且不碰服务', async () => {
    const svc = fakeService()
    const out = await call(allowAll, 'owner', svc, get())
    expect(out.status).toBe(400)
    expect(svc.calls).toEqual([])
  })

  it('GET 不存在的 slug ⇒ 404', async () => {
    const svc = fakeService({ configOf: () => undefined })
    expect((await call(allowAll, 'owner', svc, get('nope'))).status).toBe(404)
  })

  it('GET 存在的 slug ⇒ 200 + form + values（值里是掩码，不是真 secret）', async () => {
    const svc = fakeService()
    const out = await call(allowAll, 'owner', svc, get('gh'))
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
    expect((out.body.form as { key: string }[])[0]?.key).toBe('serverName')
    expect(out.text).not.toContain('Bearer')
  })

  it('POST create ⇒ 200 并把整个 body 交给服务', async () => {
    const svc = fakeService()
    const out = await call(allowAll, 'owner', svc, post({
      op: 'create', slug: 'gh', name: 'GH', description: 'd', transport: 'stdio', serverName: 'gh', command: 'npx',
    }))
    expect(out.status).toBe(200)
    expect(svc.calls).toEqual(['create:gh'])
  })

  it('POST remove ⇒ 200 且带 slug', async () => {
    const svc = fakeService()
    const out = await call(allowAll, 'owner', svc, post({ op: 'remove', slug: 'gh' }))
    expect(out.status).toBe(200)
    expect(svc.calls).toEqual(['remove:gh'])
  })

  it('服务返回不 ok ⇒ 400（输入边界问题原样带回）', async () => {
    const svc = fakeService({ async create() { return { ok: false, error: '请填写：命令', missing: ['命令'] } } })
    const out = await call(allowAll, 'owner', svc, post({ op: 'create', slug: 'x' }))
    expect(out.status).toBe(400)
    expect(out.body.missing).toEqual(['命令'])
  })

  it('授权不过 ⇒ 403，且一个服务都不调', async () => {
    const svc = fakeService()
    expect((await call(denyAll, 'member', svc, get('gh'))).status).toBe(403)
    expect((await call(denyAll, 'member', svc, post({ op: 'remove', slug: 'gh' }))).status).toBe(403)
    expect(svc.calls).toEqual([])
  })

  it('坏 JSON / 未知 op / 缺 op ⇒ 400', async () => {
    const svc = fakeService()
    for (const body of [{ op: 'nope' }, {}, [1, 2]]) {
      const out = await call(allowAll, 'owner', svc, post(body))
      expect(out.status).toBe(400)
    }
    const bad = new Request(`http://localhost${CONNECTOR_ROUTE}`, { method: 'POST', body: '{ not json' })
    expect((await call(allowAll, 'owner', svc, bad)).status).toBe(400)
  })

  it('PUT ⇒ 405', async () => {
    const svc = fakeService()
    const out = await call(allowAll, 'owner', svc, new Request(`http://localhost${CONNECTOR_ROUTE}`, { method: 'PUT' }))
    expect(out.status).toBe(405)
  })

  it('POST configure ⇒ 200，且 op/id 被剥掉后其余交给服务', async () => {
    const svc = fakeService()
    const out = await call(allowAll, 'owner', svc, post({
      op: 'configure', id: 'connector:feishu', feishuAppId: 'cli_x', feishuAppSecret: 's', readOnly: true,
    }))
    expect(out.status).toBe(200)
    expect(svc.calls[0]).toBe('configure:connector:feishu:{"feishuAppId":"cli_x","feishuAppSecret":"s","readOnly":true}')
  })

  it('configure 缺 id ⇒ 400', async () => {
    const svc = fakeService()
    expect((await call(allowAll, 'owner', svc, post({ op: 'configure' }))).status).toBe(400)
  })

  it('GET ?new=1 ⇒ 新建表单（带传输选择，字段随 transport 变）', async () => {
    const svc = fakeService()
    const out = await call(allowAll, 'owner', svc, new Request(`http://localhost${CONNECTOR_ROUTE}?new=1`))
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
    expect(svc.calls).toEqual([])
    const withTransport = await call(allowAll, 'owner', svc, new Request(`http://localhost${CONNECTOR_ROUTE}?new=1&transport=stdio`))
    expect(withTransport.status).toBe(200)
    expect(withTransport.body.values).toEqual({ transport: 'stdio' })
  })
})
