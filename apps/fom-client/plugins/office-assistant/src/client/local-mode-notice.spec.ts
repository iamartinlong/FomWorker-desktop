/**
 * 本地模式提示的验收：只有 `local` 才提示、读不到或坏值都不提示、文案说明到位。
 */
import { describe, expect, it } from 'vitest'
import { LOCAL_MODE_NOTICE, modeFromPayload, shouldShowLocalNotice } from './local-mode-notice.ts'

describe('shouldShowLocalNotice', () => {
  it('只有 local 才提示', () => {
    expect(shouldShowLocalNotice('local')).toBe(true)
    expect(shouldShowLocalNotice('signed')).toBe(false)
    expect(shouldShowLocalNotice('gate')).toBe(false)
  })

  it('未知 / 缺失 ⇒ 不提示（保守：宁可少提示也不误报）', () => {
    for (const value of [undefined, null, '', 'telepathy', 0, false, {}]) {
      expect(shouldShowLocalNotice(value)).toBe(false)
    }
  })
})

describe('modeFromPayload', () => {
  it('从宿主流式响应里取 mode', () => {
    expect(modeFromPayload({ ok: true, mode: 'local' })).toBe('local')
    expect(modeFromPayload({ ok: true, mode: null })).toBeUndefined()
  })

  it('非对象 / 非字符串 ⇒ undefined', () => {
    for (const value of [undefined, null, 'local', 42, [], { mode: 7 }]) {
      expect(modeFromPayload(value)).toBeUndefined()
    }
  })
})

describe('文案', () => {
  it('同时说明「能用的」和「要登录的」，不夸大也不隐瞒', () => {
    expect(LOCAL_MODE_NOTICE.detail).toContain('都能用')
    expect(LOCAL_MODE_NOTICE.detail).toContain('需要登录')
    expect(LOCAL_MODE_NOTICE.title).toContain('本地模式')
  })
})
