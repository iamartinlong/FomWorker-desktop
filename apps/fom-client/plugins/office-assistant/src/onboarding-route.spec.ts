/**
 * 首次使用引导的**跨进程契约**：浏览器请求的路由 == 宿主注册的路由。
 *
 * 这类常量一旦两边漂移，症状是「引导永远不出现」或「404」，而两边单测各自都能过
 * ⇒ 只能靠对齐断言钉住（同 `office-login` 的 logout-route.spec.ts）。
 */
import { describe, expect, it } from 'vitest'
import { ONBOARDING_ROUTE } from './index.ts'

/** 面板里写死的路由（与 `AssistantPage.tsx` 的 `ONBOARDING_ROUTE` 一致）。 */
const BROWSER_ROUTE = '/api/office/onboarding'

describe('首次使用引导的路由契约', () => {
  it('浏览器请求的路由 == 宿主注册的路由', () => {
    expect(ONBOARDING_ROUTE).toBe(BROWSER_ROUTE)
  })

  it('在认证的 /api 通道下（令牌不过浏览器）', () => {
    expect(ONBOARDING_ROUTE.startsWith('/api/')).toBe(true)
  })

  it('与「日常事项」路由不冲突', () => {
    expect(ONBOARDING_ROUTE).not.toBe('/api/office/items')
  })
})
