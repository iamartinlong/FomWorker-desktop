import { describe, expect, it } from 'vitest'
import type { UsageReport } from './messages.ts'
import { createMemoryQueue, createReporter } from './reporter.ts'
import { createMemoryTransport, ReportTransportError } from './transport.ts'

const msg = (turn: number): UsageReport => ({
  type: 'usage.report', tenantId: 't', userId: 'u', sessionId: 's', turn, step: 0, attempt: 0,
  model: 'm', source: 'platform', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
  at: '2026-01-01T00:00:00.000Z',
})

describe('reporter', () => {
  it('入队 + flush 送出 + ack', async () => {
    const transport = createMemoryTransport()
    const reporter = createReporter({ transport, queue: createMemoryQueue() })
    reporter.report([msg(1), msg(2)])
    expect(reporter.pendingCount()).toBe(2)
    await expect(reporter.flush()).resolves.toEqual({ sent: 2, pending: 0 })
    expect(transport.sent).toHaveLength(2)
  })

  it('传输失败则不 ack（离线补报）', async () => {
    const transport = { send: async (): Promise<void> => { throw new Error('offline') } }
    const reporter = createReporter({ transport, queue: createMemoryQueue() })
    reporter.report([msg(1)])
    await expect(reporter.flush()).rejects.toThrow('offline')
    expect(reporter.pendingCount()).toBe(1)
  })

  it('水位线取最大 seq', () => {
    const queue = createMemoryQueue()
    expect(queue.watermark('s')).toBe(0)
    queue.advance('s', 5)
    queue.advance('s', 3)
    expect(queue.watermark('s')).toBe(5)
  })

  it('分片：一轮最多 `maxPerFlush` 条，剩下的下一轮再送（逐轮 ack）', async () => {
    const transport = createMemoryTransport()
    const reporter = createReporter({ transport, queue: createMemoryQueue(), maxPerFlush: 2 })
    reporter.report([msg(1), msg(2), msg(3), msg(4), msg(5)])
    await expect(reporter.flush()).resolves.toEqual({ sent: 2, pending: 3 })
    await expect(reporter.flush()).resolves.toEqual({ sent: 2, pending: 1 })
    await expect(reporter.flush()).resolves.toEqual({ sent: 1, pending: 0 })
    expect(transport.sent).toHaveLength(5)
  })

  it('429 带 Retry-After ⇒ 记退避（retryAfterMs/blockedUntilMs），成功后退避清掉', async () => {
    let failing = true
    const now = 1_000_000
    const transport = {
      send: async (): Promise<void> => {
        if (failing) throw new ReportTransportError('上报失败：HTTP 429（Retry-After 30s）', 429, 30_000)
      },
    }
    const reporter = createReporter({ transport, queue: createMemoryQueue(), now: () => now })
    reporter.report([msg(1)])
    await expect(reporter.flush()).rejects.toThrow(/429/)
    expect(reporter.retryAfterMs()).toBe(30_000)
    expect(reporter.blockedUntilMs()).toBe(now + 30_000)
    expect(reporter.pendingCount()).toBe(1) // 一条不 ack
    failing = false
    await expect(reporter.flush()).resolves.toEqual({ sent: 1, pending: 0 })
    expect(reporter.retryAfterMs()).toBeUndefined()
    expect(reporter.blockedUntilMs()).toBeUndefined()
  })

  it('非限流失败（没带 Retry-After）⇒ 不假装知道该等多久', async () => {
    const transport = { send: async (): Promise<void> => { throw new Error('offline') } }
    const reporter = createReporter({ transport, queue: createMemoryQueue() })
    reporter.report([msg(1)])
    await expect(reporter.flush()).rejects.toThrow('offline')
    expect(reporter.retryAfterMs()).toBeUndefined()
    expect(reporter.blockedUntilMs()).toBeUndefined()
  })
})
