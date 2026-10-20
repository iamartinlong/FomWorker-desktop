import { describe, expect, it, vi } from 'vitest'
import { createTokenRefresher, expiryOf, secondsLeft, type CredentialsLike } from './token.ts'

const NOW = 1_700_000_000
const TOKEN = (exp: number): string =>
  `h.${Buffer.from(JSON.stringify({ exp, sub: 'u1' }), 'utf8').toString('base64url')}.s`

function memCreds(initial: Record<string, string>): CredentialsLike & { values: Record<string, string> } {
  const values: Record<string, string> = { ...initial }
  return {
    values,
    resolve: (ref: string) => (values[ref] === undefined ? undefined : { value: values[ref] }),
    set: (ref: string, value: string) => {
      values[ref] = value
    },
    unset: (ref: string) => {
      delete values[ref]
    },
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function build(tokenExp: number | undefined, creds: CredentialsLike, fetchImpl: typeof fetch) {
  return createTokenRefresher({
    platformUrl: 'http://platform',
    credentials: creds,
    accessRef: 'ACCESS',
    refreshRef: 'REFRESH',
    nowSeconds: () => NOW,
    fetchImpl,
  })
}

describe('JWT 到期解析', () => {
  it('解出 exp 与剩余秒数；非 JWT ⇒ undefined', () => {
    expect(expiryOf(TOKEN(NOW + 900))).toBe(NOW + 900)
    expect(secondsLeft(TOKEN(NOW + 42), NOW)).toBe(42)
    expect(expiryOf('not-a-jwt')).toBeUndefined()
    expect(secondsLeft('', NOW)).toBeUndefined()
  })
})

describe('createTokenRefresher（按需续期）', () => {
  it('还早（剩余 > 阈值）⇒ 不刷新、不打扰平台', async () => {
    const creds = memCreds({ ACCESS: TOKEN(NOW + 600), REFRESH: 'r1' })
    const fetchImpl = vi.fn(async () => jsonResponse({}))
    const result = await build(NOW + 600, creds, fetchImpl as typeof fetch).ensureFresh()
    expect(result).toEqual({ usable: true, refreshed: false, needsLogin: false })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('快过期 ⇒ 用刷新令牌换新、两个 ref 一起换', async () => {
    const creds = memCreds({ ACCESS: TOKEN(NOW + 30), REFRESH: 'r1' })
    const fetchImpl = vi.fn(async () => jsonResponse({ accessToken: TOKEN(NOW + 900), refreshToken: 'r2', expiresIn: 900 }))
    const result = await build(NOW + 30, creds, fetchImpl as typeof fetch).ensureFresh()

    expect(result).toEqual({ usable: true, refreshed: true, needsLogin: false })
    expect(creds.values.ACCESS).toBe(TOKEN(NOW + 900))
    expect(creds.values.REFRESH).toBe('r2')
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://platform/api/auth/token')
    expect(JSON.parse(String(init.body))).toEqual({ refreshToken: 'r1' })
  })

  it('刷新被拒（401）⇒ 清掉两个 ref、要求重登', async () => {
    const creds = memCreds({ ACCESS: TOKEN(NOW + 10), REFRESH: 'r1' })
    const result = await build(NOW + 10, creds, (async () => jsonResponse({}, 401)) as typeof fetch).ensureFresh()

    expect(result).toEqual({ usable: false, refreshed: false, needsLogin: true })
    expect(creds.values.ACCESS).toBeUndefined()
    expect(creds.values.REFRESH).toBeUndefined()
  })

  it('网络错 / 5xx ⇒ 保留旧令牌、不要求重登（下次再试）', async () => {
    const creds = memCreds({ ACCESS: TOKEN(NOW + 10), REFRESH: 'r1' })
    const offline = await build(NOW + 10, creds, (async () => {
      throw new Error('offline')
    }) as typeof fetch).ensureFresh()
    expect(offline).toEqual({ usable: true, refreshed: false, needsLogin: false })
    expect(creds.values.ACCESS).toBe(TOKEN(NOW + 10))

    const flaky = await build(NOW + 10, creds, (async () => jsonResponse({}, 503)) as typeof fetch).ensureFresh()
    expect(flaky).toEqual({ usable: true, refreshed: false, needsLogin: false })
    expect(creds.values.ACCESS).toBe(TOKEN(NOW + 10))
  })

  it('没有刷新令牌 ⇒ 不猜、要求重登（访问令牌还在就先让它用着）', async () => {
    const creds = memCreds({ ACCESS: TOKEN(NOW + 10) })
    const result = await build(NOW + 10, creds, (async () => jsonResponse({})) as typeof fetch).ensureFresh()
    expect(result).toEqual({ usable: true, refreshed: false, needsLogin: true })
  })

  it('凭据里没访问令牌 ⇒ 直接要求重登', async () => {
    const creds = memCreds({})
    const result = await build(undefined, creds, (async () => jsonResponse({})) as typeof fetch).ensureFresh()
    expect(result).toEqual({ usable: false, refreshed: false, needsLogin: true })
  })
})

describe('后台定时器', () => {
  it('start 后按间隔续期，stop 后不再续', async () => {
    vi.useFakeTimers()
    try {
      const creds = memCreds({ ACCESS: TOKEN(NOW + 10), REFRESH: 'r1' })
      const fetchImpl = vi.fn(async () => jsonResponse({ accessToken: TOKEN(NOW + 900), refreshToken: 'r2' }))
      const refresher = build(NOW + 10, creds, fetchImpl as typeof fetch)
      const stop = refresher.start(1_000)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      stop()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
