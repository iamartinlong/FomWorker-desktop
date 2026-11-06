import { describe, expect, it, vi } from 'vitest'
import { collectOnboardingFacts, detectModelProvider } from './onboarding-host.ts'

describe('detectModelProvider', () => {
  it('settings 里出现 llm-* 命名空间 ⇒ 已配过', () => {
    expect(detectModelProvider({ describe: () => [{ ns: 'llm-pi-ai' }, { ns: 'ui-theme' }] })).toBe(true)
  })

  it('只有非 llm 的命名空间 ⇒ 没配过', () => {
    expect(detectModelProvider({ describe: () => [{ ns: 'ui-theme' }, { ns: 'ui-settings' }] })).toBe(false)
  })

  it('读不到 settings 服务 ⇒ 保守当作「已配过」（不提示）', () => {
    expect(detectModelProvider(undefined)).toBe(true)
  })

  it('describe 抛错 ⇒ 同样保守', () => {
    expect(detectModelProvider({ describe: () => { throw new Error('boom') } })).toBe(true)
  })
})

describe('collectOnboardingFacts', () => {
  it('全新：未登录 + 没模型 + 没会话', () => {
    const facts = collectOnboardingFacts({
      signedIn: false,
      sessions: { list: () => [] },
      settings: { describe: () => [{ ns: 'ui-theme' }] },
    })
    expect(facts).toEqual({ signedIn: false, hasModelProvider: false, hasSessions: false })
  })

  it('有会话 ⇒ hasSessions=true（老用户，不该被引导）', () => {
    const facts = collectOnboardingFacts({
      signedIn: false,
      sessions: { list: () => [{ id: 's1' }] },
      settings: { describe: () => [] },
    })
    expect(facts.hasSessions).toBe(true)
  })

  it('sessions 服务缺失 ⇒ 保守当作有会话', () => {
    expect(collectOnboardingFacts({ signedIn: false }).hasSessions).toBe(true)
  })

  it('list 抛错 ⇒ 保守当作有会话', () => {
    const facts = collectOnboardingFacts({
      signedIn: false,
      sessions: { list: () => { throw new Error('boom') } },
    })
    expect(facts.hasSessions).toBe(true)
  })

  it('signedIn 原样透传', () => {
    expect(collectOnboardingFacts({ signedIn: true, sessions: { list: () => [] } }).signedIn).toBe(true)
  })
})
