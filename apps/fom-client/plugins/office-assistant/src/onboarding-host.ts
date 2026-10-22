/**
 * 宿主侧采集「首次使用引导」需要的事实。
 *
 * 与 `onboarding.ts`（纯判定）分工：那边只做决策，这边只负责「从内核/凭据读三项事实」。
 * 三者任何一个读不到都**按「已有」处理**——宁可少提示一次，也不要在老用户面前弹引导。
 */

/** 内核 `sessions` 服务的最小面。 */
interface SessionsLike {
  list?: () => Array<{ id?: unknown }>
}

/** 内核 `settings` 服务的最小面（只用到 `describe`）。 */
interface SettingsLike {
  describe?: () => Array<{ ns?: unknown }>
}

/** 采集结果。 */
export interface OnboardingFactsHost {
  readonly signedIn: boolean
  readonly hasModelProvider: boolean
  readonly hasSessions: boolean
}

/**
 * 判断有没有配过模型 provider。
 *
 * 口径：`llm-pi-ai` 这个命名空间在 `describe()` 里出现即视为「配过」——
 * 登录会写 `llm-pi-ai.providers.fom-platform`，用户自己加 BYO 也会写同一个 ns。
 * @param settings 内核 settings 服务（读不到 ⇒ 保守返回 `true`）
 * @returns 是否已有模型 provider
 */
export function detectModelProvider(settings: SettingsLike | undefined): boolean {
  if (settings?.describe === undefined) return true // 读不到 ⇒ 不提示，避免误报
  try {
    const descriptors = settings.describe()
    return descriptors.some((d) => typeof d.ns === 'string' && d.ns.startsWith('llm-'))
  } catch {
    return true // 读失败同样按「已有」处理
  }
}

/**
 * 采集三项事实。
 * @param options.signedIn 是否已登录（由调用方从模式/凭据判断）
 * @param options.sessions 内核 sessions 服务
 * @param options.settings 内核 settings 服务
 * @returns 事实集合
 */
export function collectOnboardingFacts(options: {
  signedIn: boolean
  sessions?: SessionsLike
  settings?: SettingsLike
}): OnboardingFactsHost {
  let hasSessions = true // 读不到 ⇒ 当作有会话，不打扰
  if (options.sessions?.list !== undefined) {
    try {
      hasSessions = options.sessions.list().length > 0
    } catch {
      hasSessions = true
    }
  }

  return {
    signedIn: options.signedIn,
    hasModelProvider: detectModelProvider(options.settings),
    hasSessions,
  }
}
