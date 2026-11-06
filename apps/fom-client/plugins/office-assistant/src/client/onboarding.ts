/**
 * 「首次使用引导」的**纯判定逻辑**（不碰 DOM、不碰 IO）。
 *
 * ## 为什么要它
 *
 * 数据目录隔离（`DSH_HOME` → `<userData>/dsh-home`）之后，首次启动是一个**空 home**：
 * 没有模型 key、没有会话、没有工作区，界面一片空白。2026-10-20 的真实体验是
 * 「装了却像坏了」——与「装的是 FomWorker、界面却是官方版」那个事故同一个体感坑。
 *
 * ⇒ 在**首次使用**时给一条明确的引导，而不是让用户对着空白猜。
 *
 * ## 判定口径（保守）
 *
 * 只有**明确知道是空的**才提示。任何一项读不到/不确定，都**不**提示——
 * 宁可少提示一次，也不要在老用户面前弹出「欢迎首次使用」。
 */

/** 引导要考虑的三件事。 */
export interface OnboardingFacts {
  /** 是否已登录（`signed` 才算；`local` / `gate` 都不算）。 */
  readonly signedIn: boolean
  /** 是否已经配过任何模型 provider（能读取到即为 true）。 */
  readonly hasModelProvider: boolean
  /** 是否已有过会话（有任意一条历史即为 true）。 */
  readonly hasSessions: boolean
}

/** 引导里要提示的缺口。 */
export type OnboardingGap = 'sign-in' | 'model'

/** 引导判定结果。 */
export interface OnboardingDecision {
  /** 要不要显示引导。 */
  readonly show: boolean
  /** 缺哪几项（按展示顺序）。 */
  readonly gaps: readonly OnboardingGap[]
  /** 用户是否明确关掉过引导（关掉后不再显示，除非缺口变化）。 */
  readonly dismissed: boolean
}

/** 引导的关闭标记键（浏览器 localStorage）。 */
export const ONBOARDING_DISMISSED_KEY = 'fomworker.onboarding.dismissed'

/**
 * 判定是否显示首次使用引导。
 *
 * **只在「三项全空」这种明确的首次状态下提示**：一旦用户有了模型或会话，
 * 就说明这不是首次使用，提示会变成噪音。
 * @param facts 三项事实
 * @param dismissed 用户是否已手动关掉过引导
 * @returns 判定结果（含缺口清单，供引导正文逐条说明）
 */
export function onboardingDecision(facts: OnboardingFacts, dismissed: boolean): OnboardingDecision {
  const gaps: OnboardingGap[] = []
  if (!facts.signedIn) gaps.push('sign-in')
  if (!facts.hasModelProvider) gaps.push('model')

  // 已有会话 ⇒ 这不是首次使用（哪怕是本地模式的老用户），不打扰。
  const firstRun = !facts.hasSessions
  // 用户关掉过 ⇒ 不再自动弹（缺什么仍可去设置里补）。
  const show = firstRun && !dismissed && gaps.length > 0
  return { show, gaps, dismissed }
}
