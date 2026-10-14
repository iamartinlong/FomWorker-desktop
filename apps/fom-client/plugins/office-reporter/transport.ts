import type { ReportMessage } from './messages.ts'

/**
 * 上报传输：把一批消息送到平台。WS 为正式实现（后续 K3），此处先给**内存 mock**。
 * 语义：`send` 成功即视为已送达；抛错则调用方**不 ack**（消息留在离线队列，重连补报）。
 */
export interface ReporterTransport {
  send(messages: readonly ReportMessage[]): Promise<void>
}

/** 内存传输（mock / 单测 / 联调前）。记录所有已发送消息。 */
export function createMemoryTransport(): ReporterTransport & { readonly sent: ReportMessage[] } {
  const sent: ReportMessage[] = []
  return {
    sent,
    async send(messages) {
      for (const message of messages) sent.push(message)
    },
  }
}
