import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryQueue, createReporter } from './reporter.ts'
import { createMemoryTransport, ReportTransportError } from './transport.ts'
import { createTurnEndTrigger, syncSessionLogs } from './trigger.ts'

describe('office-reporter · 折叠触发（真会话日志 → 上报）', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'fom-rep-'))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('扫会话日志 → 折用量 → 入队 → 冲队列', async () => {
    const dir = join(home, 'sessions', '--cwd--', 's1')
    mkdirSync(dir, { recursive: true })
    const record = { type: 'assistant/message', time: Date.UTC(2026, 0, 3), data: { turn: 1, step: 1, usage: { inputTokens: 7, outputTokens: 3 } } }
    writeFileSync(join(dir, 'session.v1.jsonl'), `${JSON.stringify(record)}\n`)

    const transport = createMemoryTransport()
    const reporter = createReporter({ transport, queue: createMemoryQueue() })
    const result = await syncSessionLogs(reporter, home, { tenantId: 't1', userId: 'u1', source: 'platform' })

    expect(result.sessions).toBe(1)
    expect(result.reported).toBe(1)
    expect(result.sent).toBe(1)
    expect(result.pending).toBe(0)
    expect(transport.sent).toHaveLength(1)
    expect((transport.sent[0] as { inputTokens: number; sessionId: string }).inputTokens).toBe(7)
    expect((transport.sent[0] as { sessionId: string }).sessionId).toBe('s1')
  })

  it('没有 sessions 目录 ⇒ 空跑（不抛）', async () => {
    const reporter = createReporter({ transport: createMemoryTransport(), queue: createMemoryQueue() })
    const result = await syncSessionLogs(reporter, home, { tenantId: 't', userId: 'u', source: 'platform' })
    expect(result).toEqual({ sessions: 0, reported: 0, sent: 0, pending: 0, audited: 0 })
  })

  it('传输失败 ⇒ 消息留队列（sent=0、pending>0）', async () => {
    const dir = join(home, 'sessions', 's')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl'), `${JSON.stringify({ type: 'assistant/message', time: 1, data: { turn: 1, step: 1, usage: { inputTokens: 1 } } })}\n`)
    const reporter = createReporter({
      transport: { send: async () => { throw new Error('断网') } },
      queue: createMemoryQueue(),
    })
    const result = await syncSessionLogs(reporter, home, { tenantId: 't', userId: 'u', source: 'platform' })
    expect(result.reported).toBe(1)
    expect(result.sent).toBe(0)
    expect(result.pending).toBe(1)
    expect(result.error).toContain('断网')
    expect(reporter.pendingCount()).toBe(1)
  })

  it('审计：折条目 + `seq` 水位线增量（第二次 sync 不重发）', async () => {
    const dir = join(home, 'sessions', 's')
    mkdirSync(dir, { recursive: true })
    const records = [
      { type: 'tool/call', seq: 1, time: 10, data: { name: 'read', callId: 'c1', arguments: '{"file_path":"a.txt"}' } },
      { type: 'assistant/message', seq: 2, time: 11, data: {} },
    ]
    writeFileSync(join(dir, 'session.jsonl'), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)

    const transport = createMemoryTransport()
    const reporter = createReporter({ transport, queue: createMemoryQueue() })
    const first = await syncSessionLogs(reporter, home, { tenantId: 't1', userId: 'u1', source: 'platform' })
    expect(first.reported).toBe(1)
    expect(first.sent).toBe(1)
    expect(first.audited).toBe(1)
    expect((transport.sent[0] as { type: string }).type).toBe('audit.report')

    const second = await syncSessionLogs(reporter, home, { tenantId: 't1', userId: 'u1', source: 'platform' })
    expect(second.reported).toBe(0)
    expect(second.sent).toBe(0)
    expect(second.audited).toBe(0)
    expect(transport.sent).toHaveLength(1)
  })

  it('审计传输失败 ⇒ **不前移**水位线（下次重发）', async () => {
    const dir = join(home, 'sessions', 's')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl'), `${JSON.stringify({ type: 'turn/end', seq: 5, time: 1, data: { turn: 1, reason: { kind: 'completed' } } })}\n`)
    const reporter = createReporter({
      transport: { send: async () => { throw new Error('断网') } },
      queue: createMemoryQueue(),
    })
    const result = await syncSessionLogs(reporter, home, { tenantId: 't', userId: 'u', source: 'platform' })
    expect(result.error).toContain('断网')
    expect(result.audited).toBe(0)
    expect(reporter.watermark('s')).toBe(0)
  })

  it('会话记录不带 model ⇒ 用 `defaultModel`（平台 `/report/usage` 要求 model 非空，缺了 400）', async () => {
    const dir = join(home, 'sessions', 's')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl'), `${JSON.stringify({ type: 'assistant/message', time: 1, data: { turn: 1, step: 1, usage: { inputTokens: 5 } } })}\n`)
    const transport = createMemoryTransport()
    const reporter = createReporter({ transport, queue: createMemoryQueue() })
    const result = await syncSessionLogs(reporter, home, { tenantId: 't', userId: 'u', source: 'platform', defaultModel: 'gw-model' })
    expect(result.sent).toBe(1)
    expect((transport.sent[0] as { model: string }).model).toBe('gw-model')
  })
})

describe('office-reporter · 事件驱动触发（turn/end → 防抖）', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('只认 turn/end；窗口内多次触发合成一次', async () => {
    vi.useFakeTimers()
    const sync = vi.fn(async () => ({}))
    const trigger = createTurnEndTrigger({ sync, debounceMs: 500 })
    trigger.onEvent('assistant/message')
    trigger.onEvent('step/end')
    expect(sync).not.toHaveBeenCalled()
    trigger.onEvent('turn/end')
    trigger.onEvent('turn/end')
    await vi.advanceTimersByTimeAsync(600)
    expect(sync).toHaveBeenCalledTimes(1)
  })

  it('dispose 取消未落地的触发', async () => {
    vi.useFakeTimers()
    const sync = vi.fn(async () => ({}))
    const trigger = createTurnEndTrigger({ sync, debounceMs: 500 })
    trigger.onEvent('turn/end')
    trigger.dispose()
    await vi.advanceTimersByTimeAsync(600)
    expect(sync).not.toHaveBeenCalled()
  })

  it('退避中（blocked）⇒ 这次触发直接跳过，不排定时器（消息留队列）', async () => {
    vi.useFakeTimers()
    const sync = vi.fn(async () => ({}))
    let blocked = true
    const trigger = createTurnEndTrigger({ sync, debounceMs: 500, blocked: () => blocked })
    trigger.onEvent('turn/end')
    await vi.advanceTimersByTimeAsync(600)
    expect(sync).not.toHaveBeenCalled()
    // 退避结束后照常触发（下一次 turn/end）。
    blocked = false
    trigger.onEvent('turn/end')
    await vi.advanceTimersByTimeAsync(600)
    expect(sync).toHaveBeenCalledTimes(1)
  })
})

describe('office-reporter · 限流退避进结果', () => {
  it('冲队列撞 429 ⇒ 结果带 `retryAfterMs`（不抛、消息留队列）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fom-rep-429-'))
    try {
      const dir = join(home, 'sessions', 's')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'session.jsonl'), `${JSON.stringify({ type: 'assistant/message', time: 1, data: { turn: 1, step: 1, usage: { inputTokens: 1 } } })}\n`)
      const reporter = createReporter({
        transport: { send: async () => { throw new ReportTransportError('上报失败（/api/report/usage）：HTTP 429（Retry-After 30s）', 429, 30_000) } },
        queue: createMemoryQueue(),
      })
      const result = await syncSessionLogs(reporter, home, { tenantId: 't', userId: 'u', source: 'platform' })
      expect(result.sent).toBe(0)
      expect(result.pending).toBe(1)
      expect(result.retryAfterMs).toBe(30_000)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
