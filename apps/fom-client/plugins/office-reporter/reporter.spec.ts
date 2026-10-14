import { describe, expect, it } from 'vitest'
import type { UsageReport } from './messages.ts'
import { createMemoryQueue, createReporter } from './reporter.ts'
import { createMemoryTransport } from './transport.ts'

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
})
