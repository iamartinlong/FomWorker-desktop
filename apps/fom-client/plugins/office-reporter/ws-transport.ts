import type { ReportMessage } from './messages.ts'
import type { ReporterTransport } from './transport.ts'

/** WebSocket 最小面（避免依赖具体实现/类型）。 */
export interface WebSocketLike {
  send(data: string): void
  close(): void
  addEventListener(type: 'open' | 'error', listener: () => void, options?: { once?: boolean }): void
}

/** WS 传输选项。 */
export interface WsTransportOptions {
  /** 平台 WS 地址。 */
  readonly url: string
  /** 服务令牌（作为 `?token=` 查询参数）。 */
  readonly token?: string
  /** WebSocket 构造器（默认全局 `WebSocket`）；便于测试注入。 */
  readonly createSocket?: (url: string) => WebSocketLike
  /** 连接就绪超时（ms，默认 10000）。 */
  readonly openTimeoutMs?: number
}

function defaultSocket(url: string): WebSocketLike {
  const Impl = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket
  if (Impl === undefined) throw new Error('office-reporter: 无全局 WebSocket，请注入 createSocket')
  return new Impl(url)
}

/**
 * WS 传输（对齐 C3 `client-platform.schema.json`）：把一批消息逐条 `send(JSON)`。
 * 语义：未连接则先连；连接失败**抛错**（调用方不 ack → 消息留在离线队列，重连补报）。
 * @param options - url / token / 注入 socket / 超时。
 * @returns `ReporterTransport`（附 `close`）。
 */
export function createWsTransport(options: WsTransportOptions): ReporterTransport & { close(): void } {
  const createSocket = options.createSocket ?? defaultSocket
  const openTimeoutMs = options.openTimeoutMs ?? 10_000
  const target = options.url + (options.token === undefined ? '' : `?token=${encodeURIComponent(options.token)}`)
  let socket: WebSocketLike | null = null

  const connect = (): Promise<WebSocketLike> =>
    new Promise((resolve, reject) => {
      const ws = createSocket(target)
      const timer = setTimeout(() => {
        try {
          ws.close()
        } catch {
          /* 关闭失败忽略 */
        }
        reject(new Error('office-reporter: ws 连接超时'))
      }, openTimeoutMs)
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer)
          socket = ws
          resolve(ws)
        },
        { once: true },
      )
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer)
          reject(new Error('office-reporter: ws 连接失败'))
        },
        { once: true },
      )
    })

  return {
    async send(messages: readonly ReportMessage[]) {
      const ws = socket ?? (await connect())
      for (const message of messages) ws.send(JSON.stringify(message))
    },
    close() {
      try {
        socket?.close()
      } catch {
        /* 关闭失败忽略 */
      }
      socket = null
    },
  }
}
