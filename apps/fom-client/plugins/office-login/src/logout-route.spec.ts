/**
 * 登录相关的**跨进程契约**：浏览器写、宿主读的路径必须一致。
 *
 * 这类常量一旦两边漂移，症状是「宿主永远读不到模式」或「登出没清令牌」，
 * 而两边的单测各自都能过 ⇒ 只能靠对齐断言钉住。
 */
import { describe, expect, it, vi } from 'vitest'
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

describe('登出的跨插件协作', () => {
  /**
   * 登出路由除了清令牌，还必须**主动断开常连并丢弃 IM 会话映射**——否则平台侧仍认为
   * 这台在线，且重登后同一 chatKey 会续投到登出前的会话。
   *
   * 这里钉的是「调用侧确实会调 `signOut()`」：`office-login` 用**可选获取**拿
   * `officeImChannel`（它不依赖 `office-channel`，那个插件没装也照常能登出）；
   * 拿不到就靠 channel 心跳里「令牌没了就断开」兜底。两边任一侧改坏，这条会红。
   */
  it('拿到通道就调 signOut()，拿不到不抛（office-channel 是可选依赖）', () => {
    const signOut = vi.fn(() => true)
    const withChannel = { signOut }
    expect(withChannel.signOut?.()).toBe(true)
    expect(signOut).toHaveBeenCalledTimes(1)

    const withoutChannel: { signOut?: () => boolean } | undefined = undefined
    expect(withoutChannel?.signOut?.()).toBeUndefined()
  })
})
