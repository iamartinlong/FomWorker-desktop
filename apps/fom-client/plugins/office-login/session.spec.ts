import { describe, expect, it } from 'vitest'
import { SESSION_URL, createMemoryStore, createSession, userFromToken } from './session.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

const b64url = (obj: object): string => Buffer.from(JSON.stringify(obj)).toString('base64url')
/** 造一个不验签的假 JWT（payload 承载身份）。 */
const fakeJwt = (claims: object): string => `${b64url({ alg: 'none' })}.${b64url(claims)}.sig`

describe('createSession（浏览器侧；登录经宿主代理）', () => {
  it('登录成功：打**宿主**登录路由、存身份、返回用户', async () => {
    const store = createMemoryStore()
    let calledUrl = ''
    const session = createSession({
      store,
      fetchImpl: (async (url: string) => {
        calledUrl = String(url)
        return jsonResponse({ ok: true, user: { userId: 'u1', tenantId: 't1', email: 'x' } })
      }) as unknown as typeof fetch,
    })
    const user = await session.login({ method: 'email', email: 'x', password: 'y' })
    expect(user.userId).toBe('u1')
    expect(calledUrl).toBe(SESSION_URL)
    expect(session.current()?.user.tenantId).toBe('t1')
  })

  it('宿主回 ok:false ⇒ 抛（带平台消息），不存会话', async () => {
    const session = createSession({
      store: createMemoryStore(),
      fetchImpl: (async () => jsonResponse({ ok: false, status: 401, message: '邮箱或密码不正确' })) as unknown as typeof fetch,
    })
    await expect(session.login({ method: 'email' })).rejects.toThrow('邮箱或密码不正确')
    expect(session.current()).toBeNull()
  })

  it('HTTP 非 2xx ⇒ 抛', async () => {
    const session = createSession({ store: createMemoryStore(), fetchImpl: (async () => jsonResponse({}, 500)) as unknown as typeof fetch })
    await expect(session.login({ method: 'email' })).rejects.toThrow('HTTP 500')
  })

  it('logout 清会话', async () => {
    const session = createSession({
      store: createMemoryStore(),
      fetchImpl: (async () => jsonResponse({ ok: true, user: { userId: 'u', tenantId: 't' } })) as unknown as typeof fetch,
    })
    await session.login({ method: 'email' })
    session.logout()
    expect(session.current()).toBeNull()
  })

  it('userFromToken：解 JWT / 非法串返回 null', () => {
    expect(userFromToken(fakeJwt({ sub: 'u', tenant_id: 't' }))).toEqual({ userId: 'u', tenantId: 't' })
    expect(userFromToken('not-a-jwt')).toBeNull()
    expect(userFromToken(fakeJwt({ foo: 'bar' }))).toBeNull()
  })
})
