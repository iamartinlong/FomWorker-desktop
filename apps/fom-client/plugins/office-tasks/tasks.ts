/**
 * **任务面**（客户端侧，纯逻辑）：把内核会话事件翻成「任务状态」上报。
 *
 * ○ D-5：**task = 会话**，状态取 turn（`running` / `idle` / `failed`）；
 * ○ 标题取**首条用户输入**（截断 80 字），之后不再覆盖；
 * ○ 只上报不做别的（执行端恒在 PC）。
 */

/** 从内核消息里取正文（只取 `text` 块）。 */
export function textOf(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const item = block as { type?: unknown; text?: unknown }
    if (item.type === 'text' && typeof item.text === 'string' && item.text.trim() !== '') parts.push(item.text)
  }
  return parts.join(' ').trim()
}

/** 标题：首条用户输入截断（超长加省略号）。 */
export function taskTitle(text: string, limit = 80): string | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`
}

/** 会话事件 → 任务状态；不关心的类型返回 undefined（不空报）。 */
export function statusOf(eventType: string): 'running' | 'idle' | undefined {
  if (eventType === 'turn/start') return 'running'
  if (eventType === 'turn/end') return 'idle'
  return undefined
}
