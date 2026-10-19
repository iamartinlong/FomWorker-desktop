/**
 * 「简报推 IM」验收：抬头/计数、超长截断、失败不抛、没通道安静跳过。
 */
import { describe, expect, it, vi } from 'vitest'
import { digestMessage, MAX_PUSH_CHARS, pushDigest } from './digest-push.ts'
import type { AssistantDigest } from './digest.ts'

const DIGEST: AssistantDigest = {
  id: '2026-10-19',
  date: '2026-10-19',
  createdAt: 1_790_000_000_000,
  openCount: 2,
  doneToday: 1,
  overdueCount: 1,
  lines: ['今天完成 1 条：交周报', '还有 2 条没做完，其中 1 条已逾期', '· [逾期] 报销', '· 看书'],
  text: '今天完成 1 条：交周报\n还有 2 条没做完，其中 1 条已逾期\n· [逾期] 报销\n· 看书',
}

describe('digestMessage', () => {
  it('抬头带日期，第二行是计数摘要', () => {
    const message = digestMessage(DIGEST)
    expect(message.split('\n')[0]).toBe('📋 2026-10-19 日终收拢')
    expect(message.split('\n')[1]).toBe('完成 1 · 待办 2 · 逾期 1')
    expect(message).toContain('· [逾期] 报销')
  })

  it('待办清空时摘要显示「已清空」', () => {
    const cleared: AssistantDigest = { ...DIGEST, openCount: 0, overdueCount: 0 }
    expect(digestMessage(cleared).split('\n')[1]).toBe('完成 1 · 已清空')
  })

  it('今天没完成、也没逾期 ⇒ 摘要只剩待办', () => {
    const plain: AssistantDigest = { ...DIGEST, doneToday: 0, overdueCount: 0 }
    expect(digestMessage(plain).split('\n')[1]).toBe('待办 2')
  })

  it('超长正文截断，且总长不超上限', () => {
    const huge: AssistantDigest = { ...DIGEST, text: '很长的待办内容\n'.repeat(500) }
    const message = digestMessage(huge)
    expect(message.length).toBeLessThanOrEqual(MAX_PUSH_CHARS)
    expect(message.endsWith('…')).toBe(true)
    // 抬头必须还在（截断只砍正文）。
    expect(message.startsWith('📋 2026-10-19 日终收拢')).toBe(true)
  })
})

describe('pushDigest', () => {
  it('有通道 ⇒ 发 digest.notify 帧，带日期与正文', () => {
    const send = vi.fn((_frame: unknown) => true)
    const ok = pushDigest(DIGEST, { channel: { send } })
    expect(ok).toBe(true)
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0]?.[0]).toMatchObject({ type: 'digest.notify', date: '2026-10-19' })
  })

  it('没通道（未装 office-channel / 没连上）⇒ 安静跳过', () => {
    expect(pushDigest(DIGEST, {})).toBe(false)
    expect(pushDigest(DIGEST, { channel: undefined })).toBe(false)
  })

  it('send 抛异常 ⇒ 返回 false 并留声（不往外抛）', () => {
    const warn = vi.fn()
    const ok = pushDigest(DIGEST, {
      channel: { send: () => { throw new Error('socket 已断') } },
      warn,
    })
    expect(ok).toBe(false)
    expect(warn).toHaveBeenCalledWith('简报推 IM 失败：socket 已断')
  })

  it('send 返回 false（通道未连上）⇒ 如实返回 false', () => {
    expect(pushDigest(DIGEST, { channel: { send: () => false } })).toBe(false)
  })
})
