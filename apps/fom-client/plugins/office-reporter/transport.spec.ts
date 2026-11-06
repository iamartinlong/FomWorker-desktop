import { describe, expect, it, vi } from 'vitest'
import { createHttpTransport, parseRetryAfter, ReportTransportError } from './transport.ts'
import type { AuditReport, UsageReport } from './messages.ts'

const usage: UsageReport = {
  type: 'usage.report',
  tenantId: 't1',
  userId: 'u1',
  sessionId: 's1',
  turn: 1,
  step: 2,
  attempt: 0,
  model: 'm',
  source: 'platform',
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  at: '2026-10-15T00:00:00.000Z',
}
const audit: AuditReport = { type: 'audit.report', tenantId: 't1', userId: 'u1', sessionId: 's1', seq: 3, time: 1, eventType: 'tool', detail: { a: 1 } }

describe('createHttpTransport（真上报）', () => {
  it('按类型分流到 /usage 与 /audit，剥离 `type`，带 Bearer', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init })
      return { ok: true, status: 202, headers: new Headers() } as Response
    }) as unknown as typeof fetch
    const transport = createHttpTransport({ platformUrl: 'http://p/', token: () => 'TK', fetchImpl })
    await transport.send([usage, audit])
    expect(calls.map((c) => c.url)).toEqual(['http://p/api/report/usage', 'http://p/api/report/audit'])
    const first = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    expect(first.type).toBeUndefined()
    expect(first.tenantId).toBe('t1')
    expect(first.inputTokens).toBe(10)
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe('Bearer TK')
  })

  it('任一条非 2xx 即抛（调用方不 ack）', async () => {
    let n = 0
    const fetchImpl = (async () => {
      n += 1
      return { ok: n === 1, status: n === 1 ? 202 : 403, headers: new Headers() } as Response
    }) as unknown as typeof fetch
    const transport = createHttpTransport({ platformUrl: 'http://p', token: () => 'TK', fetchImpl })
    await expect(transport.send([usage, audit])).rejects.toThrow('HTTP 403')
  })

  it('空批不发请求；令牌为空则不带 authorization', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 202, headers: new Headers() }) as Response) as unknown as typeof fetch
    const transport = createHttpTransport({ platformUrl: 'http://p', token: () => '', fetchImpl })
    await transport.send([])
    expect(fetchImpl).not.toHaveBeenCalled()
    await transport.send([usage])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('令牌源可以是异步的（从 ctx.credentials 读）', async () => {
    let seen = ''
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen = (init.headers as Record<string, string>).authorization ?? ''
      return { ok: true, status: 202, headers: new Headers() } as Response
    }) as unknown as typeof fetch
    const transport = createHttpTransport({ platformUrl: 'http://p', token: async () => 'ASYNC', fetchImpl })
    await transport.send([usage])
    expect(seen).toBe('Bearer ASYNC')
  })
})

describe('parseRetryAfter（只认整数秒）', () => {
  it('整数秒 → 毫秒；0 也认', () => {
    expect(parseRetryAfter('30')).toBe(30_000)
    expect(parseRetryAfter(' 5 ')).toBe(5_000)
    expect(parseRetryAfter('0')).toBe(0)
  })

  it('HTTP-date / 空 / 非法 → undefined（不猜）', () => {
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT')).toBeUndefined()
    expect(parseRetryAfter('')).toBeUndefined()
    expect(parseRetryAfter('-1')).toBeUndefined()
    expect(parseRetryAfter('1.5')).toBeUndefined()
    expect(parseRetryAfter(null)).toBeUndefined()
  })
})

describe('限流（429 + Retry-After）', () => {
  it('429 ⇒ 抛 ReportTransportError（带 status 与退避毫秒），且**只发一条就停**', async () => {
    let n = 0
    const fetchImpl = (async () => {
      n += 1
      return new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } })
    }) as unknown as typeof fetch
    const transport = createHttpTransport({ platformUrl: 'http://p', token: () => 'TK', fetchImpl })
    const error = await transport.send([usage, audit]).then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(ReportTransportError)
    const typed = error as ReportTransportError
    expect(typed.status).toBe(429)
    expect(typed.retryAfterMs).toBe(30_000)
    expect(typed.message).toContain('Retry-After 30s')
    // 第一条就停：后面的消息一条都不发（限流时别把剩下的额度也烧掉）。
    expect(n).toBe(1)
  })

  it('429 但没给 Retry-After ⇒ retryAfterMs 缺席（不编一个等待时长）', async () => {
    const fetchImpl = (async () => new Response('', { status: 429 })) as unknown as typeof fetch
    const transport = createHttpTransport({ platformUrl: 'http://p', token: () => 'TK', fetchImpl })
    const error = await transport.send([usage]).then(() => null, (e: unknown) => e) as ReportTransportError
    expect(error.status).toBe(429)
    expect(error.retryAfterMs).toBeUndefined()
  })
})
