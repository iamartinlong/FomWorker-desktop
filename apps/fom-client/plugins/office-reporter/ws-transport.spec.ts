import { describe, expect, it } from 'vitest'
import type { UsageReport } from './messages.ts'
import { createWsTransport, type WebSocketLike } from './ws-transport.ts'

const msg = (turn: number): UsageReport => ({
  type: 'usage.report', tenantId: 't', userId: 'u', sessionId: 's', turn, step: 0, attempt: 0,
  model: 'm', source: 'byo', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
  at: '2026-01-01T00:00:00.000Z',
})

/** 连上即触发的假 socket。 */
function autoOpenSocket(sent: string[]): WebSocketLike {
  const listeners: { open: (() => void)[]; error: (() => void)[] } = { open: [], error: [] }
  return {
    send(data) {
      sent.push(data)
    },
    close() {},
    addEventListener(type, listener) {
      listeners[type].push(listener)
      if (type === 'open') queueMicrotask(() => listener())
    },
  }
}

/** 触发 error 的假 socket。 */
function errorSocket(): WebSocketLike {
  const listeners: { open: (() => void)[]; error: (() => void)[] } = { open: [], error: [] }
  return {
    send() {},
    close() {},
    addEventListener(type, listener) {
      listeners[type].push(listener)
      if (type === 'error') queueMicrotask(() => listener())
    },
  }
}

describe('createWsTransport', () => {
  it('连接后逐条 send JSON', async () => {
    const sent: string[] = []
    const transport = createWsTransport({ url: 'ws://platform/ws', createSocket: () => autoOpenSocket(sent) })
    await transport.send([msg(1), msg(2)])
    expect(sent.map((s) => (JSON.parse(s) as { type: string }).type)).toEqual(['usage.report', 'usage.report'])
  })

  it('token 作为查询参数', async () => {
    let url = ''
    const transport = createWsTransport({ url: 'ws://platform/ws', token: 'abc', createSocket: (u) => { url = u; return autoOpenSocket([]) } })
    await transport.send([msg(1)])
    expect(url).toBe('ws://platform/ws?token=abc')
  })

  it('连接失败抛错（调用方不 ack）', async () => {
    const transport = createWsTransport({ url: 'ws://platform/ws', createSocket: () => errorSocket() })
    await expect(transport.send([msg(1)])).rejects.toThrow('ws 连接失败')
  })
})
