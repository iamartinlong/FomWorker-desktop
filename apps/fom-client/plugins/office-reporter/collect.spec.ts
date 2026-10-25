import { describe, expect, it } from 'vitest'
import { collectSession } from './collect.ts'
import { createMemoryQueue, createReporter } from './reporter.ts'
import { createMemoryTransport } from './transport.ts'

describe('collectSession', () => {
  it('折叠会话用量 + 审计 → 入队', () => {
    const reporter = createReporter({ transport: createMemoryTransport(), queue: createMemoryQueue() })
    const n = collectSession(
      reporter,
      's1',
      [{ type: 'assistant/message', time: 0, data: { usage: { inputTokens: 5 }, turn: 1, step: 0 } }],
      { tenantId: 't', userId: 'u', source: 'byo' },
      [{ tenant: 't', sessionId: 's1', seq: 3, time: 0, type: 'tool/call', detail: {} }],
    )
    expect(n).toBe(2)
    expect(reporter.pendingCount()).toBe(2)
  })

  it('无内容不入队', () => {
    const reporter = createReporter({ transport: createMemoryTransport(), queue: createMemoryQueue() })
    expect(collectSession(reporter, 's1', [], { tenantId: 't', userId: 'u', source: 'byo' })).toBe(0)
    expect(reporter.pendingCount()).toBe(0)
  })
})
