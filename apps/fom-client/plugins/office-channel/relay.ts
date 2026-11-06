/**
 * **IM 中继的客户端解析**（纯函数，便于单测）：把平台投下来的 `im.relay` 帧折成
 * 「投给哪个会话 + 说什么」。
 *
 * 平台那一侧已经做完「`open_id` → 员工」的绑定解析与路由（见 `平台 im_binding` + webhook），
 * 所以桌面这一侧**不再查路由表**：帧到了就说明是发给本机这个用户的。
 * 剩下的只是「这条消息属于哪个会话」——用 `channel + chatId`（缺 chatId 时退回 `openId`）当会话键，
 * 同一会话的后续消息续投到同一个本地会话。
 */

/** `im.relay` 帧的最小形状（与 `ws/client-platform.schema.json` 对齐）。 */
export interface RelayFrame {
  readonly channel?: unknown
  readonly openId?: unknown
  readonly payload?: unknown
}

/** 折好的中继消息。 */
export interface RelayMessage {
  /** 会话键：`<channel>:<chatId|openId>`。 */
  readonly chatKey: string
  /** 渠道（feishu / dingtalk / wecom）。 */
  readonly channel: string
  /** 发送者 IM 标识（原样带，用于审计/回显）。 */
  readonly openId: string
  /** 会话 id（平台侧 chat id；缺省空串）——回消息用它。 */
  readonly chatId: string
  /** 正文（交给本地会话当首个/下一个输入）。 */
  readonly text: string
  /** 平台侧的消息 id（幂等去重用；缺省空串）。 */
  readonly messageId: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 折一条 `im.relay` 帧；形状不对（缺渠道/缺 openId）⇒ `undefined`（调用方丢弃并留声）。
 * @param frame - WS 收到的帧。
 * @returns 中继消息或 undefined。
 */
export function relayMessage(frame: RelayFrame): RelayMessage | undefined {
  const channel = str(frame.channel)
  const openId = str(frame.openId)
  if (channel === '' || openId === '') return undefined

  const payload = asRecord(frame.payload) ?? {}
  const text = str(payload.text).trim()
  if (text === '') return undefined

  const chatId = str(payload.chatId)
  return {
    chatKey: `${channel}:${chatId === '' ? openId : chatId}`,
    channel,
    openId,
    chatId,
    text,
    messageId: str(payload.messageId),
  }
}
