import { describe, expect, it } from 'vitest'
import { toInboundMessage } from './feishu-map.ts'

describe('office-inbound · 飞书事件映射', () => {
  it('原始 event：文本消息 → {openId,text}', () => {
    const event = { sender: { sender_id: { open_id: 'ou_x' } }, message: { message_type: 'text', content: JSON.stringify({ text: '你好' }) } }
    expect(toInboundMessage(event)).toEqual({ openId: 'ou_x', text: '你好' })
  })

  it('外层信封 {event:...} 亦可', () => {
    const envelope = { schema: '2.0', event: { sender: { sender_id: { open_id: 'ou_y' } }, message: { message_type: 'text', content: JSON.stringify({ text: 'hi' }) } } }
    expect(toInboundMessage(envelope)).toEqual({ openId: 'ou_y', text: 'hi' })
  })

  it('非文本消息 → undefined（丢弃）', () => {
    const event = { sender: { sender_id: { open_id: 'ou_x' } }, message: { message_type: 'image', content: '{}' } }
    expect(toInboundMessage(event)).toBeUndefined()
  })

  it('缺 open_id → undefined', () => {
    expect(toInboundMessage({ message: { message_type: 'text', content: '{"text":"x"}' } })).toBeUndefined()
  })

  it('content 非 JSON → 原文兜底', () => {
    const event = { sender: { sender_id: { open_id: 'ou_x' } }, message: { message_type: 'text', content: 'plain' } }
    expect(toInboundMessage(event)).toEqual({ openId: 'ou_x', text: 'plain' })
  })
})
