/**
 * 本地模式提示的**文案与判定**（纯逻辑，可单测）。
 *
 * 为什么要有它（设计稿 D-6）：本地模式下平台能力（派活 / 我的任务 / IM）不可用，
 * 但**入口不该灰掉**——灰掉会让人不知道产品有云端能力。做法是保留入口、在页面顶部
 * 说明「哪些要登录」，点了再给一句人话。
 *
 * 判定来源：宿主 `GET /api/office/login/mode`（浏览器 localStorage 看不见宿主，
 * 而这条路由是宿主侧唯一权威）。读不到 ⇒ **不提示**（保守：宁可少提示，也不误报）。
 */

/** 本地模式提示条的内容。 */
export interface LocalModeNotice {
  /** 一句话标题。 */
  readonly title: string
  /** 一行说明：哪些能用、哪些要登录。 */
  readonly detail: string
}

/** 本地模式的提示文案（一处定义，面板与测试共用）。 */
export const LOCAL_MODE_NOTICE: LocalModeNotice = {
  title: '本地模式 · 未登录',
  detail: 'AI 对话、文件、技能、待办都能用；派活、我的任务、IM 手机接力需要登录平台。',
}

/** 宿主模式路由（与 `office-login` 宿主半一致）。 */
export const MODE_ROUTE = '/api/office/login/mode'

/**
 * 是否该显示本地模式提示。
 * @param mode 宿主返回的模式（`'gate'` / `'local'` / `'signed'`，或未知）
 * @returns 只有 `local` 才提示
 */
export function shouldShowLocalNotice(mode: unknown): boolean {
  return mode === 'local'
}

/**
 * 从宿主路由的响应体里取模式。
 * @param payload `GET /api/office/login/mode` 的响应
 * @returns 模式字符串，或 `undefined`
 */
export function modeFromPayload(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const mode = (payload as { mode?: unknown }).mode
  return typeof mode === 'string' ? mode : undefined
}
