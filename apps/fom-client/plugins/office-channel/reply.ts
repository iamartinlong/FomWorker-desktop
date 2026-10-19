/**
 * **回消息**（客户端侧收集，纯逻辑）：把「IM 中继建的那个会话」的**最后一条助手正文**收下来，
 * 在 `turn/end` 时吐出来交给通道发回 IM。
 *
 * 为什么在客户端：平台不知道 agent 什么时候答完；桌面侧天然能看到内核事件流
 * （`session/event`，`assistant/message` + `turn/end`）。
 */

/** 从内核 `assistant/message` 的 `message` 里取正文（只取 `text` 块，其余块忽略）。 */
export function assistantText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const item = block as { type?: unknown; text?: unknown }
    if (item.type === 'text' && typeof item.text === 'string' && item.text.trim() !== '') parts.push(item.text)
  }
  return parts.join('\n').trim()
}

/**
 * 按会话记「最后一条助手正文」，`turn/end` 时取走：
 * - `assistant/message` ⇒ 覆盖该会话的候选正文（同一轮多次发言取最后一条）；
 * - `turn/end` ⇒ 返回并清空（没有正文就返回 undefined，不空发）。
 */
export class ImReplyCollector {
  private readonly last = new Map<string, string>()

  /** 吃一条内核会话事件；需要回消息时返回正文。 */
  onEvent(sessionId: string, type: string, data: unknown): string | undefined {
    if (sessionId === '') return undefined
    if (type === 'assistant/message') {
      const text = assistantText((data as { message?: unknown } | undefined)?.message)
      if (text !== '') this.last.set(sessionId, text)
      return undefined
    }
    if (type === 'turn/end') {
      const text = this.last.get(sessionId)
      this.last.delete(sessionId)
      return text === '' ? undefined : text
    }
    return undefined
  }

  /** 会话不再照看（例如被关掉）⇒ 丢掉残留。 */
  forget(sessionId: string): void {
    this.last.delete(sessionId)
  }
}
