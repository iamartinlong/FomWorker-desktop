import type { ReportMessage } from './messages.ts'
import type { ReporterTransport } from './transport.ts'

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

/** 上报器：入队 + 冲队列（离线容错：冲失败则消息留在队列）。 */
export interface Reporter {
  /** 入队一批消息。 */
  report(messages: readonly ReportMessage[]): void
  /** 冲队列：把当前待发全部送出，成功则 ack。 */
  flush(): Promise<{ sent: number; pending: number }>
  /** 当前待发条数。 */
  pendingCount(): number
}

/**
 * 造上报器。
 * @param deps - 传输 + 队列。
 * @returns 上报器。
 */
export function createReporter(deps: { transport: ReporterTransport; queue: ReporterQueue }): Reporter {
  return {
    report(messages) {
      if (messages.length > 0) deps.queue.enqueue(messages)
    },
    pendingCount() {
      return deps.queue.pending().length
    },
    async flush() {
      const batch = deps.queue.pending()
      if (batch.length === 0) return { sent: 0, pending: 0 }
      await deps.transport.send(batch)
      deps.queue.ack(batch.length)
      return { sent: batch.length, pending: deps.queue.pending().length }
    },
  }
}
