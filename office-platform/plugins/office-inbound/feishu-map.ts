/**
 * 飞书入站事件 → `InboundMessage` 映射（M2/C · 层①）。纯函数、可测；传输（长连接桥）随后调用。
 *
 * 兼容两种入参：① 原始 `im.message.receive_v1` **event**（`{sender,message}`）；
 * ② 外层信封（`{event:{sender,message}}`，SDK 有时这么给）。只收**文本**消息，其余**丢弃**（返回 `undefined`）。
 * 取 `sender.sender_id.open_id`；正文取 `message.content`（JSON `{"text":...}`）。
 */

import type { InboundMessage } from './inbound.ts'

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * 把一条飞书入站事件映射成 `InboundMessage`。
 * @param payload - 原始 event 或外层信封。
 * @returns 文本消息的 `{openId, text}`；非文本 / 缺 open_id 则 `undefined`（丢弃）。
 */
export function toInboundMessage(payload: unknown): InboundMessage | undefined {
  const root = record(payload)
  const event = root.event !== undefined ? record(root.event) : root
  const sender = record(event.sender)
  const senderId = record(sender.sender_id)
  const openId = str(senderId.open_id) ?? str(sender.open_id) ?? str(root.openId)
  if (openId === undefined) return undefined

  const message = record(event.message)
  const type = str(message.message_type) ?? 'text'
  if (type !== 'text') return undefined

  const content = str(message.content)
  if (content !== undefined) {
    try {
      const parsed = record(JSON.parse(content))
      if (typeof parsed.text === 'string') return { openId, text: parsed.text }
    } catch {
      // 非 JSON 正文：按原文兜底（见下）
    }
  }
  return { openId, text: content ?? str(message.text) ?? '' }
}
