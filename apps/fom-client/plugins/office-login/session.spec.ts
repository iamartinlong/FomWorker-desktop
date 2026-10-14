import { describe, expect, it } from 'vitest'
import { createMemoryStore, createSession, userFromToken } from './session.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

const b64url = (obj: object): string => Buffer.from(JSON.stringify(obj)).toString('base64url')
/** 造一个不验签的假 JWT（payload 承载身份）。 */
const fakeJwt = (claims: object): string => `${b64url({ alg: 'none' })}.${b64url(claims)}.sig`

describe('createSession', () => {
  it('登录成功存会话并返回用户', async () => {
    const store = createMemoryStore()
    const session = createSession({
      platformUrl: 'http://p',
      store,
      fetchImpl: (async () => jsonResponse({ accessToken: 'a', refreshToken: 'r', user: { userId: 'u1', tenantId: 't1', email: 'x' } })) as unknown as typeof fetch,
    })
    const user = await session.login({ method: 'email', email: 'x', password: 'y' })
    expect(user.userId).toBe('u1')
    expect(session.token()).toBe('a')
    expect(session.current()?.user.tenantId).toBe('t1')
  })

  it('登录失败抛错（不存会话）', async () => {
    const session = createSession({ platformUrl: 'http://p', store: createMemoryStore(), fetchImpl: (async () => jsonResponse({}, 401)) as unknown as typeof fetch })
    await expect(session.login({ method: 'email' })).rejects.toThrow('HTTP 401')
    expect(session.token()).toBeNull()
  })

  it('logout 清会话', async () => {
    const session = createSession({
      platformUrl: 'http://p',
      store: createMemoryStore(),
      fetchImpl: (async () => jsonResponse({ accessToken: 'a', refreshToken: 'r', user: { userId: 'u', tenantId: 't' } })) as unknown as typeof fetch,
    })
    await session.login({ method: 'email' })
    session.logout()
    expect(session.token()).toBeNull()
  })

  it('登录响应无 user 时，从 JWT 解身份', async () => {
    const session = createSession({
      platformUrl: 'http://p',
      store: createMemoryStore(),
      fetchImpl: (async () =>
        jsonResponse({ accessToken: fakeJwt({ sub: 'u1', tenant_id: 't1', email: 'x@y', role: 'owner' }), refreshToken: 'r' })) as unknown as typeof fetch,
    })
    const user = await session.login({ method: 'email', email: 'x', password: 'y' })
    expect(user).toEqual({ userId: 'u1', tenantId: 't1', email: 'x@y', role: 'owner' })
  })

  it('userFromToken：解 JWT / 非法串返回 null', () => {
    expect(userFromToken(fakeJwt({ sub: 'u', tenant_id: 't' }))).toEqual({ userId: 'u', tenantId: 't' })
    expect(userFromToken('not-a-jwt')).toBeNull()
    expect(userFromToken(fakeJwt({ foo: 'bar' }))).toBeNull()
  })
})
