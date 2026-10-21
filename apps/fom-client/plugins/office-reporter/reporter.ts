import type { ReportMessage } from './messages.ts'
import { ReportTransportError, type ReporterTransport } from './transport.ts'

/**
 * 离线队列 + 增量水位线。正式实现落磁盘（断网缓存、重连补报）；此处先给**内存实现**。
 * - `enqueue` 入队；`pending` 读当前待发；`ack(n)` 移除已送达的前 n 条；
 * - `watermark(sessionId)` / `advance(sessionId, seq)` 记审计 `seq` 水位线（增量上报）。
 */
export interface ReporterQueue {
  enqueue(messages: readonly ReportMessage[]): void
  pending(): readonly ReportMessage[]
  ack(count: number): void
  watermark(sessionId: string): number
  advance(sessionId: string, seq: number): void
}

/** 内存队列。 */
export function createMemoryQueue(): ReporterQueue {
  let queue: ReportMessage[] = []
  const watermarks = new Map<string, number>()
  return {
    enqueue(messages) {
      queue.push(...messages)
    },
    pending() {
      return queue
    },
    ack(count) {
      queue = queue.slice(count)
    },
    watermark(sessionId) {
      return watermarks.get(sessionId) ?? 0
    },
    advance(sessionId, seq) {
      if (seq > (watermarks.get(sessionId) ?? 0)) watermarks.set(sessionId, seq)
    },
  }
}

/** 每轮 flush 最多送出的条数（缺省）：大积压不一次性轰平台（它按 IP 限流 `/report/*`，② N 批）。 */
export const DEFAULT_MAX_PER_FLUSH = 50

/** 上报器：入队 + 冲队列（离线容错：冲失败则消息留在队列）。 */
export interface Reporter {
  /** 入队一批消息。 */
  report(messages: readonly ReportMessage[]): void
  /** 冲队列：把当前待发**按每轮上限分片**送出，成功则 ack；失败抛且一条不 ack。 */
  flush(): Promise<{ sent: number; pending: number }>
  /** 当前待发条数。 */
  pendingCount(): number
  /** 某会话已上报到的审计 `seq` 水位线（增量折叠用）。 */
  watermark(sessionId: string): number
  /** 前移某会话的审计水位线（**仅在成功送出后**调）。 */
  advance(sessionId: string, seq: number): void
  /** 上次失败时平台给的退避毫秒（`Retry-After`；没有/不可解析 ⇒ undefined）；成功后清掉。 */
  retryAfterMs(): number | undefined
  /** 退避到哪个时刻（毫秒时间戳；没在退避 ⇒ undefined）。 */
  blockedUntilMs(): number | undefined
}

/**
 * 造上报器。
 * @param deps - 传输 + 队列 + 每轮上限（缺省 `DEFAULT_MAX_PER_FLUSH`）+ 时钟（单测）。
 * @returns 上报器。
 */
export function createReporter(deps: {
  transport: ReporterTransport
  queue: ReporterQueue
  maxPerFlush?: number
  now?: () => number
}): Reporter {
  const maxPerFlush = deps.maxPerFlush ?? DEFAULT_MAX_PER_FLUSH
  const now = deps.now ?? (() => Date.now())
  let retryAfterMs: number | undefined
  let blockedUntil: number | undefined
  return {
    report(messages) {
      if (messages.length > 0) deps.queue.enqueue(messages)
    },
    pendingCount() {
      return deps.queue.pending().length
    },
    async flush() {
      const all = deps.queue.pending()
      if (all.length === 0) return { sent: 0, pending: 0 }
      // 分片：一轮最多 `maxPerFlush` 条；剩下的下一轮再送（水位线/幂等由平台兜）。
      const batch = all.slice(0, maxPerFlush)
      try {
        await deps.transport.send(batch)
      } catch (error) {
        // 限流提示只在平台真给了 `Retry-After` 时才记；其余失败不假装知道该等多久。
        retryAfterMs = error instanceof ReportTransportError ? error.retryAfterMs : undefined
        blockedUntil = retryAfterMs === undefined ? undefined : now() + retryAfterMs
        throw error
      }
      deps.queue.ack(batch.length)
      retryAfterMs = undefined
      blockedUntil = undefined
      return { sent: batch.length, pending: deps.queue.pending().length }
    },
    watermark: (sessionId) => deps.queue.watermark(sessionId),
    advance: (sessionId, seq) => {
      deps.queue.advance(sessionId, seq)
    },
    retryAfterMs: () => retryAfterMs,
    blockedUntilMs: () => blockedUntil,
  }
}
