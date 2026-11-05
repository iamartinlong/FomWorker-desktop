import { describe, expect, it } from 'vitest'
import { createLoginFetch } from './index.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
}

const b64url = (obj: object): string => Buffer.from(JSON.stringify(obj)).toString('base64url')
const fakeJwt = (claims: object): string => `${b64url({ alg: 'none' })}.${b64url(claims)}.sig`

function request(body: unknown): Request {
  return new Request('http://x/api/office/login/session', { method: 'POST', body: JSON.stringify(body) })
}

describe('createLoginFetch（宿主登录代理）', () => {
  it('平台 200 ⇒ 令牌写凭据、回 user、写 provider', async () => {
    const set: Array<[string, string]> = []
    const updates: Array<[string, object]> = []
    const fetchImpl = (async (url: string) => {
      expect(String(url)).toBe('http://p/api/auth/login')
      return jsonResponse({ accessToken: fakeJwt({ sub: 'u1', tenant_id: 't1', email: 'x@y', role: 'owner' }), refreshToken: 'r' })
    }) as unknown as typeof fetch
    const handler = createLoginFetch({
      platformUrl: 'http://p',
      providerId: 'fom-platform',
      provider: { baseURL: 'http://g/v1' },
      credentials: { set: (ref, value) => { set.push([ref, value]) } },
      settings: { update: async (ns, patch) => { updates.push([ns, patch]) } },
      fetchImpl,
    })
    const res = await handler(request({ method: 'email', email: 'x', password: 'y' }))
    const body = (await res.json()) as { ok: boolean; user: { userId: string }; provider: string | null }
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.user.userId).toBe('u1')
    expect(body.provider).toBe('fom-platform')
    // 访问令牌 + 刷新令牌都落凭据（后者供续期器用：访问令牌 15 分钟就过期）
    expect(set).toHaveLength(2)
    expect(set[0]?.[0]).toBe('FOM_PLATFORM_TOKEN')
    expect(set[1]).toEqual(['FOM_PLATFORM_REFRESH', 'r'])
    expect(updates[0]?.[0]).toBe('llm-pi-ai')
  })

  it('平台 401 ⇒ ok:false + status + 消息（**不写凭据**）', async () => {
    const set: unknown[] = []
    const handler = createLoginFetch({
      platformUrl: 'http://p',
      providerId: 'fom-platform',
      credentials: { set: () => { set.push(1) } },
      fetchImpl: (async () => jsonResponse({ title: '邮箱或密码不正确' }, 401)) as unknown as typeof fetch,
    })
    const body = (await (await handler(request({ method: 'email' }))).json()) as { ok: boolean; status: number; message: string }
    expect(body.ok).toBe(false)
    expect(body.status).toBe(401)
    expect(body.message).toContain('邮箱或密码不正确')
    expect(set).toHaveLength(0)
  })

  it('连不上平台 ⇒ ok:false + 提示（不抛）', async () => {
    const handler = createLoginFetch({
      platformUrl: 'http://p',
      providerId: 'fom-platform',
      credentials: { set: () => {} },
      fetchImpl: (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch,
    })
    const body = (await (await handler(request({ method: 'email' }))).json()) as { ok: boolean; message: string }
    expect(body.ok).toBe(false)
    expect(body.message).toContain('连不上平台')
    expect(body.message).toContain('ECONNREFUSED')
  })

  it('平台没回 accessToken ⇒ ok:false', async () => {
    const handler = createLoginFetch({
      platformUrl: 'http://p',
      providerId: 'fom-platform',
      credentials: { set: () => {} },
      fetchImpl: (async () => jsonResponse({ refreshToken: 'r' })) as unknown as typeof fetch,
    })
    const body = (await (await handler(request({ method: 'email' }))).json()) as { ok: boolean; message: string }
    expect(body.ok).toBe(false)
    expect(body.message).toContain('accessToken')
  })

  it('未配 provider ⇒ 只做 K1（provider:null）', async () => {
    const handler = createLoginFetch({
      platformUrl: 'http://p',
      providerId: 'fom-platform',
      credentials: { set: () => {} },
      fetchImpl: (async () => jsonResponse({ accessToken: fakeJwt({ sub: 'u', tenant_id: 't' }) })) as unknown as typeof fetch,
    })
    const body = (await (await handler(request({ method: 'email' }))).json()) as { ok: boolean; provider: string | null }
    expect(body.ok).toBe(true)
    expect(body.provider).toBeNull()
  })

  it('请求体不是 JSON ⇒ 400', async () => {
    const handler = createLoginFetch({ platformUrl: 'http://p', providerId: 'p', credentials: { set: () => {} } })
    const res = await handler(new Request('http://x', { method: 'POST', body: 'not-json' }))
    expect(res.status).toBe(400)
  })
})
