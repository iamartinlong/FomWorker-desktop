import { describe, expect, it } from 'vitest'
import { relayMessage } from './relay.ts'

const frame = {
  type: 'im.relay',
  channel: 'feishu',
  openId: 'ou_1',
  payload: { messageId: 'om-1', chatId: 'oc-1', messageType: 'text', text: '  你好  ' },
}

describe('relayMessage', () => {
  it('折出会话键（channel:chatId）、正文去空白、带上消息 id', () => {
    expect(relayMessage(frame)).toEqual({
      chatKey: 'feishu:oc-1',
      channel: 'feishu',
      openId: 'ou_1',
      chatId: 'oc-1',
      text: '你好',
      messageId: 'om-1',
    })
  })

  it('缺 chatId ⇒ 会话键退回 openId（同一人私聊续投同一会话）', () => {
    expect(relayMessage({ ...frame, payload: { text: 'hi' } })?.chatKey).toBe('feishu:ou_1')
  })

  it('缺渠道 / 缺 openId / 正文空 ⇒ undefined（调用方丢弃）', () => {
    expect(relayMessage({ ...frame, channel: '' })).toBeUndefined()
    expect(relayMessage({ ...frame, openId: '' })).toBeUndefined()
    expect(relayMessage({ ...frame, payload: { text: '   ' } })).toBeUndefined()
    expect(relayMessage({ ...frame, payload: undefined })).toBeUndefined()
    expect(relayMessage({ channel: 1, openId: 'x', payload: { text: 'y' } })).toBeUndefined()
  })
})
