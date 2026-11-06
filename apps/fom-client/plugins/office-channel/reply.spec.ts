import { describe, expect, it } from 'vitest'
import { assistantText, ImReplyCollector } from './reply.ts'

function assistant(...texts: string[]) {
  return { message: { role: 'assistant', content: texts.map((text) => ({ type: 'text', text })) } }
}

describe('assistantText（只取 text 块）', () => {
  it('多段拼接、忽略非 text 块与空白', () => {
    expect(
      assistantText({
        content: [
          { type: 'text', text: '第一段' },
          { type: 'tool_use', id: 't1' },
          { type: 'text', text: '  ' },
          { type: 'text', text: '第二段' },
        ],
      }),
    ).toBe('第一段\n第二段')
  })

  it('形状不对/没有正文 ⇒ 空串', () => {
    expect(assistantText(undefined)).toBe('')
    expect(assistantText({ content: 'nope' })).toBe('')
    expect(assistantText({ content: [] })).toBe('')
  })
})

describe('ImReplyCollector（turn/end 取正文）', () => {
  it('同一轮多次 assistant/message 取最后一条；turn/end 取走并清空', () => {
    const collector = new ImReplyCollector()
    expect(collector.onEvent('s1', 'assistant/message', assistant('草稿'))).toBeUndefined()
    expect(collector.onEvent('s1', 'assistant/message', assistant('最终答案'))).toBeUndefined()
    expect(collector.onEvent('s1', 'turn/end', {})).toBe('最终答案')
    // 取走后没有残留：下一轮没有正文就不空发
    expect(collector.onEvent('s1', 'turn/end', {})).toBeUndefined()
  })

  it('没有正文的 turn/end ⇒ undefined（不空发）', () => {
    const collector = new ImReplyCollector()
    expect(collector.onEvent('s1', 'turn/end', {})).toBeUndefined()
  })

  it('按会话隔离；forget 丢掉残留', () => {
    const collector = new ImReplyCollector()
    collector.onEvent('s1', 'assistant/message', assistant('给 s1'))
    collector.onEvent('s2', 'assistant/message', assistant('给 s2'))
    expect(collector.onEvent('s2', 'turn/end', {})).toBe('给 s2')
    collector.forget('s1')
    expect(collector.onEvent('s1', 'turn/end', {})).toBeUndefined()
  })
})
