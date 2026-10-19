/**
 * 登录相关的**跨进程契约**：浏览器写、宿主读的路径必须一致。
 *
 * 这类常量一旦两边漂移，症状是「宿主永远读不到模式」或「登出没清令牌」，
 * 而两边的单测各自都能过 ⇒ 只能靠对齐断言钉住。
 */
import { describe, expect, it } from 'vitest'
import { LOGOUT_ROUTE, SESSION_ROUTE } from './index.ts'
import { MODE_ROUTE as BROWSER_MODE_ROUTE } from './client/login-state.ts'

/** 宿主半声明的模式路由（与 `src/index.ts` 的 `MODE_ROUTE` 一致）。 */
const HOST_MODE_ROUTE = '/api/office/login/mode'

describe('跨进程路由契约', () => {
  it('浏览器写的模式路由 == 宿主监听的路由', () => {
    expect(BROWSER_MODE_ROUTE).toBe(HOST_MODE_ROUTE)
  })

  it('登出与登录共用路径（靠 HTTP 方法区分：POST 登录 / DELETE 登出）', () => {
    expect(LOGOUT_ROUTE).toBe(SESSION_ROUTE)
  })

  it('三条路由都在认证的 /api 通道下（令牌不过浏览器）', () => {
    for (const route of [SESSION_ROUTE, BROWSER_MODE_ROUTE]) {
      expect(route.startsWith('/api/')).toBe(true)
    }
  })
})
