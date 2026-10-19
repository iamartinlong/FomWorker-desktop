/**
 * `office-channel` 的装配与投递单测：不起 cordis、不发网络（假 socket + 假凭据 + 假会话服务）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, toWsUrl, type OfficeChannelConfig, type SocketLike } from './index.ts'

class FakeSocket implements SocketLike {
  readonly sent: string[] = []
  closed = false
  private readonly listeners = new Map<string, ((event?: { data?: unknown }) => void)[]>()

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
    this.emit('close')
  }

  addEventListener(type: string, listener: (event?: { data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  emit(type: string, event?: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

interface Harness {
  ctx: Context
  sockets: FakeSocket[]
  created: number
  followed: unknown[]
  logs: string[]
  /** 改「凭据库」里的平台令牌（模拟登录/续期写入）。 */
  setToken(value: string | undefined): void
}

function harness(options: { token?: string } = {}): Harness {
  const sockets: FakeSocket[] = []
  const logs: string[] = []
  const followed: unknown[] = []
  const state = { created: 0 }
  /** 假内核 `agents`：`create` 回 handle（带 followup）并记进表里，`get` 供续投（与真服务同形）。 */
  const createdAgents = new Map<string, { followup(message: unknown): void }>()
  const agents = {
    create: async (request: { sessionId: unknown }) => {
      state.created += 1
      const agent = { followup: (message: unknown) => { followed.push({ sessionId: request.sessionId, message }) } }
      createdAgents.set(String(request.sessionId), agent)
      return { agent }
    },
    get: (sessionId: unknown) => createdAgents.get(String(sessionId)),
  }
  /** 假内核 `agentDefaultModel`（`agents.create` 要 provider/model）。 */
  const agentDefaultModel = { currentSelection: () => ({ provider: 'provider-x', model: 'model-x' }) }
  /** 可变的「凭据库」：登录后由用例改写（模拟 watcher 写入）。 */
  let storedToken = options.token
  const setToken = (value: string | undefined): void => { storedToken = value }
  const ctx = {
    logger: () => ({ info: (m: string) => { logs.push(m) }, warn: (m: string) => { logs.push(m) } }),
    // 声明式注入走属性代理（与真 ctx 一致）。
    agents,
    agentDefaultModel,
    get: (key: string) =>
      key === 'credentials' ? { resolve: async () => storedToken === undefined ? undefined : { value: storedToken } } : undefined,
    effect: (setup: () => (() => void) | void) => setup(),
    on: (_name: string, _handler: (...args: unknown[]) => void) => () => {},
    reflect: { provide: () => () => {} },
  }
  return {
    setToken,
    ctx: ctx as unknown as Context,
    sockets,
    get created() { return state.created },
    followed,
    logs,
  }
}

const config: OfficeChannelConfig = {
  platformUrl: 'http://platform.test',
  tokenRef: 'FOM_PLATFORM_TOKEN',
  enabled: true,
  heartbeatMs: 30_000,
  reconnectBaseMs: 5_000,
  loginRetryMs: 5_000,
  deviceId: '',
}

const relayFrame = (text: string, chatId = 'oc-1') => JSON.stringify({
  type: 'im.relay',
  channel: 'feishu',
  openId: 'ou_1',
  payload: { messageId: 'om-1', chatId, messageType: 'text', text },
})

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('office-channel', () => {
  // 用了假定时器的用例若中途超时，finally 不一定兜住 ⇒ 每例后强制复位，免得泄漏到下一例。
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  /** 关键状态走 stderr（真 web 进程里插件 logger 不进 stdout）⇒ 测试把它捕下来断言。 */
  const stderr: string[] = []
  const capture = (): void => {
    stderr.length = 0
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk))
      return true
    })
  }
  it('toWsUrl：http→ws、https→wss，路径固定 /api/ws，尾斜杠归一', () => {
    expect(toWsUrl('http://localhost:5028')).toBe('ws://localhost:5028/api/ws')
    expect(toWsUrl('https://platform.example/')).toBe('wss://platform.example/api/ws')
  })

  it('未配 platformUrl ⇒ 休眠：不建 socket', () => {
    capture()
    const h = harness({ token: 'tk' })
    apply(h.ctx, { ...config, platformUrl: '' }, { createSocket: (url) => { const s = new FakeSocket(url); h.sockets.push(s); return s } })
    expect(h.sockets).toEqual([])
    expect(stderr.join('\n')).toContain('休眠')
  })

  it('没登录（凭据里没令牌）⇒ 不建 socket（等重连）', async () => {
    capture()
    const h = harness()
    apply(h.ctx, config, { createSocket: (url) => { const s = new FakeSocket(url); h.sockets.push(s); return s } })
    await flush()
    expect(h.sockets).toEqual([])
    expect(stderr.join('\n')).toContain('等登录')
  })

  it('没令牌 ⇒ 等登录 + **固定短间隔**重试（不走指数退避），登录后下一次就重连', async () => {
    vi.useFakeTimers()
    try {
      capture()
      const h = harness({ token: undefined })
      apply(h.ctx, { ...config, platformUrl: 'http://platform', loginRetryMs: 1_000 }, {
        createSocket: (url) => { const s = new FakeSocket(url); h.sockets.push(s); return s },
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(stderr.join('\\n')).toContain('等登录')
      expect(h.sockets.length).toBe(0)

      // 固定 1s ⇒ 三次重试后仍是 1s（不退避成 2s/4s）
      await vi.advanceTimersByTimeAsync(3_000)
      expect(h.sockets.length).toBe(0)
      expect(stderr.filter((line) => line.includes('等登录')).length).toBeGreaterThanOrEqual(3)

      // 登录后（凭据里出现令牌）⇒ 下一次重试就真去连
      h.setToken('token-1')
      await vi.advanceTimersByTimeAsync(1_100)
      expect(h.sockets.length).toBe(1)
      expect(h.sockets[0].url).toContain('token=token-1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('有令牌 ⇒ 连上并在 open 后按间隔发 heartbeat', async () => {
    vi.useFakeTimers()
    try {
      const h = harness({ token: 'tk' })
      apply(h.ctx, config, { createSocket: (url) => { const s = new FakeSocket(url); h.sockets.push(s); return s } })
      await vi.advanceTimersByTimeAsync(0)   // 让 connect() 的微任务链跑完（假定时器下不能等真 setTimeout）
      const socket = h.sockets[0]!
      expect(socket.url).toBe('ws://platform.test/api/ws?token=tk')
      socket.emit('open')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(socket.sent.filter(m => m.includes('heartbeat'))).toHaveLength(1)
      socket.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('im.relay ⇒ 建会话 + 把正文投进会话；同一 chatId 续投同一会话', async () => {
    capture()
    const h = harness({ token: 'tk' })
    apply(h.ctx, config, { createSocket: (url) => { const s = new FakeSocket(url); h.sockets.push(s); return s } })
    await flush()
    const socket = h.sockets[0]!
    socket.emit('open')

    socket.emit('message', { data: relayFrame('第一条') })
    await flush()
    socket.emit('message', { data: relayFrame('第二条') })
    await flush()

    expect(stderr.join('\n')).toContain('IM 消息已投进会话')   // 投递有声音（真进程靠这行看）
    expect(h.created).toBe(1)                      // 同一 chatId：只建一个会话
    expect(h.followed).toHaveLength(2)             // 两条都投了
    const first = String((h.followed[0] as { sessionId: unknown }).sessionId)
    const second = String((h.followed[1] as { sessionId: unknown }).sessionId)
    expect(first).toBe(second)                     // 续投到同一个会话
    expect(first).toMatch(/^session-/)              // 会话 id 由我们生成
    socket.close()
  })

  it('另一个 chatId ⇒ 另建一个会话', async () => {
    const h = harness({ token: 'tk' })
    apply(h.ctx, config, { createSocket: (url) => { const s = new FakeSocket(url); h.sockets.push(s); return s } })
    await flush()
    const socket = h.sockets[0]!
    socket.emit('open')

    socket.emit('message', { data: relayFrame('A', 'oc-A') })
    await flush()
    socket.emit('message', { data: relayFrame('B', 'oc-B') })
    await flush()

    expect(h.created).toBe(2)
    socket.close()
  })

  it('坏帧 / 形状不对的中继 / 未知类型 ⇒ 只留声，不投递', async () => {
    const h = harness({ token: 'tk' })
    apply(h.ctx, config, { createSocket: (url) => { const s = new FakeSocket(url); h.sockets.push(s); return s } })
    await flush()
    const socket = h.sockets[0]!
    socket.emit('open')

    socket.emit('message', { data: '{ 不是 json' })
    socket.emit('message', { data: JSON.stringify({ type: 'im.relay', channel: 'feishu', openId: 'ou_1' }) })   // 缺正文
    socket.emit('message', { data: JSON.stringify({ type: 'quota.downlink' }) })                              // 暂未消费
    await flush()

    expect(h.created).toBe(0)
    expect(h.followed).toEqual([])
    expect(h.logs.join('\n')).toContain('无法解析')
    expect(h.logs.join('\n')).toContain('暂未消费')
    socket.close()
  })
})
