import { describe, expect, it } from 'vitest'
import { bindingViews, createImBindingsFetch, IM_BINDINGS_ROUTE, IM_CHANNELS } from './bindings.ts'

const TOKEN = 'platform-token-1'

function creds(value: string | undefined) {
  return {
    resolve: (ref: string) => (ref === 'FOM_PLATFORM_TOKEN' && value !== undefined ? { value } : undefined),
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function request(method: string, init: { body?: unknown; query?: string } = {}): Request {
  return new Request(`http://host${IM_BINDINGS_ROUTE}${init.query ?? ''}`, {
    method,
    ...(init.body === undefined
      ? {}
      : { body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } }),
  })
}

describe('bindingViews（渠道口径）', () => {
  it('补齐 channelLabel/idKind；非数组/坏行被吃掉', () => {
    const rows = bindingViews([
      { id: 'b1', channel: 'dingtalk', openId: 'u1' },
      { id: 'b2', channel: 'feishu', openId: 'ou_x', channelLabel: '飞书', idKind: 'open_id' },
      { channel: 'feishu' },
      null,
    ])
    expect(rows).toEqual([
      { id: 'b1', channel: 'dingtalk', channelLabel: '钉钉', idKind: 'userid', openId: 'u1' },
      { id: 'b2', channel: 'feishu', channelLabel: '飞书', idKind: 'open_id', openId: 'ou_x' },
    ])
    expect(bindingViews({ nope: true })).toEqual([])
  })

  it('三渠道的展示口径齐全', () => {
    expect(IM_CHANNELS.map((c) => `${c.channel}:${c.label}:${c.idKind}`)).toEqual([
      'feishu:飞书:open_id',
      'dingtalk:钉钉:userid',
      'wecom:企业微信:userid',
    ])
  })
})

describe('createImBindingsFetch（宿主代理，令牌不过浏览器）', () => {
  it('未登录 ⇒ 401，不打平台', async () => {
    let called = 0
    const handler = createImBindingsFetch({
      platformUrl: 'http://platform',
      credentials: creds(undefined),
      fetchImpl: (async () => {
        called += 1
        return jsonResponse([])
      }) as typeof fetch,
    })
    const res = await handler(request('GET'))
    expect(res.status).toBe(401)
    expect(called).toBe(0)
  })

  it('GET ⇒ 带 Bearer 打平台、回 bindings', async () => {
    let seen: { url?: string; auth?: string } = {}
    const handler = createImBindingsFetch({
      platformUrl: 'http://platform',
      credentials: creds(TOKEN),
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen = {
          url: String(input),
          auth: new Headers(init?.headers).get('authorization') ?? '',
        }
        return jsonResponse([{ id: 'b1', channel: 'wecom', openId: 'u9' }])
      }) as typeof fetch,
    })
    const payload = (await (await handler(request('GET'))).json()) as {
      ok: boolean
      bindings: Array<{ channelLabel: string }>
    }
    expect(seen.url).toBe('http://platform/api/config/im-bindings')
    expect(seen.auth).toBe(`Bearer ${TOKEN}`)
    expect(payload.ok).toBe(true)
    expect(payload.bindings[0]?.channelLabel).toBe('企业微信')
  })

  it('POST 渠道不认/空标识 ⇒ 400 且不打平台', async () => {
    let called = 0
    const handler = createImBindingsFetch({
      platformUrl: 'http://platform',
      credentials: creds(TOKEN),
      fetchImpl: (async () => {
        called += 1
        return jsonResponse({})
      }) as typeof fetch,
    })
    expect((await handler(request('POST', { body: { channel: 'slack', openId: 'x' } }))).status).toBe(400)
    expect((await handler(request('POST', { body: { channel: 'feishu', openId: '   ' } }))).status).toBe(400)
    expect(called).toBe(0)
  })

  it('POST ⇒ 渠道归一后转发；平台 409 原样回 ok:false + status', async () => {
    const bodies: unknown[] = []
    let status = 409
    const handler = createImBindingsFetch({
      platformUrl: 'http://platform',
      credentials: creds(TOKEN),
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)))
        return status === 409
          ? jsonResponse({ detail: '该 open_id 已被绑定' }, 409)
          : jsonResponse({ id: 'b2', channel: 'dingtalk', openId: 'u1', channelLabel: '钉钉', idKind: 'userid' })
      }) as typeof fetch,
    })
    const conflict = (await (await handler(request('POST', { body: { channel: ' DingTalk ', openId: 'u1' } }))).json()) as {
      ok: boolean
      status: number
    }
    expect(conflict.ok).toBe(false)
    expect(conflict.status).toBe(409)
    expect(bodies[0]).toEqual({ channel: 'dingtalk', openId: 'u1' })

    status = 200
    const ok = (await (await handler(request('POST', { body: { channel: 'dingtalk', openId: 'u1' } }))).json()) as {
      ok: boolean
      binding: { channelLabel: string }
    }
    expect(ok.ok).toBe(true)
    expect(ok.binding.channelLabel).toBe('钉钉')
  })

  it('DELETE ?id= ⇒ 打平台 /{id}；缺 id ⇒ 400', async () => {
    const urls: string[] = []
    const handler = createImBindingsFetch({
      platformUrl: 'http://platform',
      credentials: creds(TOKEN),
      fetchImpl: (async (input: RequestInfo | URL) => {
        urls.push(String(input))
        return new Response(null, { status: 204 })
      }) as typeof fetch,
    })
    const res = (await (await handler(request('DELETE', { query: '?id=b1' }))).json()) as { ok: boolean }
    expect(res.ok).toBe(true)
    expect(urls[0]).toBe('http://platform/api/config/im-bindings/b1')
    expect((await handler(request('DELETE'))).status).toBe(400)
  })
})
