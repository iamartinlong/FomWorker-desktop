import { describe, expect, it } from 'vitest'
import { statusOf, taskTitle, textOf } from './tasks.ts'

describe('textOf（只取 text 块）', () => {
  it('多段拼接、忽略非 text 与空白', () => {
    expect(
      textOf({
        content: [
          { type: 'text', text: '帮我' },
          { type: 'tool_use', id: 't' },
          { type: 'text', text: '汇总今天的邮件' },
        ],
      }),
    ).toBe('帮我 汇总今天的邮件')
    expect(textOf(undefined)).toBe('')
  })
})

describe('taskTitle（首条输入截断 80）', () => {
  it('空 ⇒ undefined；超长加省略号', () => {
    expect(taskTitle('   ')).toBeUndefined()
    expect(taskTitle('写周报')).toBe('写周报')
    const long = 'x'.repeat(100)
    expect(taskTitle(long)).toBe(`${'x'.repeat(80)}…`)
  })
})

describe('statusOf（turn → 任务状态）', () => {
  it('turn/start ⇒ running；turn/end ⇒ idle；其他 undefined（不空报）', () => {
    expect(statusOf('turn/start')).toBe('running')
    expect(statusOf('turn/end')).toBe('idle')
    expect(statusOf('assistant/message')).toBeUndefined()
  })
})
