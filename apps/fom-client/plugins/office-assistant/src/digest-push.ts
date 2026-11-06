/**
 * 「日终简报推 IM」的**编排层**（纯逻辑 + 注入的发送）。
 *
 * 口径：
 * - 简报正文**只在这一跳出现**，平台只做投递、不落库（D-3 本机优先）；
 * - 推送失败**不影响**本机已落盘的简报（面板照常可见）；
 * - 没绑定 IM / 通道没连上 ⇒ 安静跳过，不报错、不重试到打扰（平台侧有自己的重试与去重）。
 */
import type { AssistantDigest } from './digest.ts'

/** 发送通道（`officeImChannel` 的最小面）。 */
export interface DigestChannel {
  send(frame: unknown): boolean
}

/** 推一份简报。 */
export interface DigestPushDeps {
  /** 通道（拿不到 ⇒ 未接通道，跳过）。 */
  channel?: DigestChannel | undefined
  /** 日志落的位（低频；失败才写）。 */
  warn?: (message: string) => void
}

/** 推送帧上限（与平台 `MaxReplyChars` 对齐，留一点余量）。 */
export const MAX_PUSH_CHARS = 3_800

/**
 * 把简报折成一条 IM 文本。
 *
 * 加一行抬头（日期 + 计数），让人在 IM 里不点开也知道是什么；
 * 正文超长就截断——宁可少几行，也不让整条发不出去。
 * @param digest 简报
 * @returns 要发的正文
 */
export function digestMessage(digest: AssistantDigest): string {
  const head = `📋 ${digest.date} 日终收拢`
  const stat = [
    digest.doneToday > 0 ? `完成 ${String(digest.doneToday)}` : null,
    digest.openCount > 0 ? `待办 ${String(digest.openCount)}` : '已清空',
    digest.overdueCount > 0 ? `逾期 ${String(digest.overdueCount)}` : null,
  ].filter((part): part is string => part !== null).join(' · ')

  const full = `${head}\n${stat}\n\n${digest.text}`
  if (full.length <= MAX_PUSH_CHARS) return full
  // 截断时保留抬头，正文砍到上限以内（按字符算，避免切半个代理对）。
  const room = MAX_PUSH_CHARS - (head.length + stat.length + 2 + 2)
  const clipped = [...digest.text].slice(0, Math.max(0, room)).join('')
  return `${head}\n${stat}\n\n${clipped}…`
}

/**
 * 推一份简报（失败不抛）。
 * @param digest 简报
 * @param deps 通道
 * @returns 是否真的发出去了
 */
export function pushDigest(digest: AssistantDigest, deps: DigestPushDeps): boolean {
  if (deps.channel === undefined) return false
  try {
    return deps.channel.send({ type: 'digest.notify', date: digest.date, text: digestMessage(digest) })
  } catch (error) {
    // 推送失败不该影响本机已落盘的简报。
    deps.warn?.(`简报推 IM 失败：${String((error as Error)?.message ?? error)}`)
    return false
  }
}
