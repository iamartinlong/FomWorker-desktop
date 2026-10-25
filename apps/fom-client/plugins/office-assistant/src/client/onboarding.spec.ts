import { describe, expect, it } from 'vitest'
import { onboardingDecision, type OnboardingFacts } from './onboarding.ts'

const facts = (patch: Partial<OnboardingFacts> = {}): OnboardingFacts => ({
  signedIn: false,
  hasModelProvider: false,
  hasSessions: false,
  ...patch,
})

describe('onboardingDecision', () => {
  it('全新 home（未登录 + 没模型 + 没会话）⇒ 显示引导，缺两项', () => {
    const d = onboardingDecision(facts(), false)
    expect(d.show).toBe(true)
    expect(d.gaps).toEqual(['sign-in', 'model'])
  })

  it('已登录但没模型 ⇒ 仍引导，但只提示「配模型」', () => {
    const d = onboardingDecision(facts({ signedIn: true }), false)
    expect(d.show).toBe(true)
    expect(d.gaps).toEqual(['model'])
  })

  it('有会话 ⇒ 不是首次使用，不打扰（哪怕是本地模式老用户）', () => {
    const d = onboardingDecision(facts({ hasSessions: true }), false)
    expect(d.show).toBe(false)
  })

  it('用户手动关掉过 ⇒ 不再自动弹', () => {
    const d = onboardingDecision(facts(), true)
    expect(d.show).toBe(false)
    expect(d.dismissed).toBe(true)
  })

  it('已登录 + 有模型 ⇒ 什么都不缺，不显示', () => {
    const d = onboardingDecision(facts({ signedIn: true, hasModelProvider: true }), false)
    expect(d.show).toBe(false)
    expect(d.gaps).toEqual([])
  })

  it('缺口按固定顺序：先登录，后模型（引导正文据此逐条展开）', () => {
    expect(onboardingDecision(facts(), false).gaps).toEqual(['sign-in', 'model'])
    expect(onboardingDecision(facts({ hasModelProvider: true }), false).gaps).toEqual(['sign-in'])
  })
})
