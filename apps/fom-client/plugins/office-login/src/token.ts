/**
 * `office-login` —— **令牌自动续期**（纯逻辑，可测）。
 *
 * 平台访问令牌只有 **15 分钟**（`Jwt:AccessTokenMinutes`），刷新令牌 **14 天**（`/auth/token`）。
 * 客户端把访问令牌放进凭据库、所有出站（通道握手 / 上报 / 任务 / 审批回执 / 模型网关 `apiKeyEnv`）
 * 都读这一个值 ⇒ **不续期就会每 15 分钟静默失效**（先 401，再表现为「必须重登」）。
 *
 * 口径：
 * - 剩余 < `thresholdSeconds`（缺省 120s）才刷新（省请求）；
 * - 刷新成功 ⇒ 两个 ref 一起换新；
 * - 刷新被拒（401/403）⇒ 清掉两个 ref 并标记 `needsLogin`（刷新令牌也废了，只能重登）；
 * - **网络/5xx** ⇒ 保留旧令牌（下次再试），不误伤当前会话。
 */

/** 契约 `TokenPair` 的最小面。 */
export interface TokenPairLike {
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresIn?: number
}

/** 凭据库最小面（内核 `credentials` 服务）。 */
export interface CredentialsLike {
  resolve?(ref: string): Promise<{ value: string } | undefined> | { value: string } | undefined
  set(ref: string, value: string): Promise<void> | void
  unset?(ref: string): Promise<void> | void
}

/** JWT 的 `exp`（**秒**）；解不出（非 JWT / 无 payload）给 `undefined`。 */
export function expiryOf(token: string): number | undefined {
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as {
      exp?: unknown
    }
    return typeof payload.exp === 'number' ? payload.exp : undefined
  } catch {
    return undefined
  }
}

/** 距到期还有多少秒；解不出 `exp` 给 `undefined`（调用方按「不知道 ⇒ 不刷」处理）。 */
export function secondsLeft(token: string, nowSeconds: number): number | undefined {
  const exp = expiryOf(token)
  return exp === undefined ? undefined : exp - nowSeconds
}

/** 续期依赖。 */
export interface RefresherDeps {
  /** 平台 API 基址（已去尾斜杠）。 */
  readonly platformUrl: string
  readonly credentials: CredentialsLike
  /** 访问令牌的凭据 ref。 */
  readonly accessRef: string
  /** 刷新令牌的凭据 ref。 */
  readonly refreshRef: string
  /** 提前多久刷新（秒，缺省 120）。 */
  readonly thresholdSeconds?: number
  /** 可注入 fetch（单测）。 */
  readonly fetchImpl?: typeof fetch
  /** 可注入时钟（秒；单测）。 */
  readonly nowSeconds?: () => number
  /** 状态留声（stderr / 日志文件由调用方决定）。 */
  readonly report?: (message: string) => void
}

/** 一次续期的结果。 */
export interface RefreshResult {
  /** 现在能不能用（`true` ⇒ 凭据里有未过期的访问令牌）。 */
  readonly usable: boolean
  /** 这次是否真换了新令牌。 */
  readonly refreshed: boolean
  /** 刷新令牌失效 ⇒ 必须重新登录。 */
  readonly needsLogin: boolean
}

/** 续期器：`ensureFresh()` 按需续、`start()` 后台定时。 */
export interface TokenRefresher {
  ensureFresh(): Promise<RefreshResult>
  /** 起后台定时器；返回停止函数。 */
  start(everyMs: number): () => void
}

const read = async (deps: RefresherDeps, ref: string): Promise<string> => {
  const resolved = await deps.credentials.resolve?.(ref)
  return resolved?.value ?? ''
}

/**
 * 造续期器。
 * @param deps 平台地址 / 凭据 / 时钟与 fetch 注入
 * @returns 续期器
 */
export function createTokenRefresher(deps: RefresherDeps): TokenRefresher {
  const threshold = deps.thresholdSeconds ?? 120
  const doFetch = deps.fetchImpl ?? fetch
  const now = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000))
  const report = deps.report ?? (() => {})

  const ensureFresh = async (): Promise<RefreshResult> => {
    const accessToken = await read(deps, deps.accessRef)
    if (accessToken === '') return { usable: false, refreshed: false, needsLogin: true }

    const left = secondsLeft(accessToken, now())
    // 解不出 exp（不是 JWT）⇒ 不猜、不动（宁可让它按 401 自然失败）。
    if (left === undefined) return { usable: true, refreshed: false, needsLogin: false }
    if (left >= threshold) return { usable: true, refreshed: false, needsLogin: false }

    const refreshToken = await read(deps, deps.refreshRef)
    if (refreshToken === '') {
      report('访问令牌快过期，但凭据里没有刷新令牌 ⇒ 需要重新登录')
      return { usable: left > 0, refreshed: false, needsLogin: true }
    }

    let response: Response
    try {
      response = await doFetch(`${deps.platformUrl}/api/auth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      })
    } catch (error) {
      report(`刷新令牌时连不上平台（保留旧令牌，稍后重试）：${String((error as Error)?.message ?? error)}`)
      return { usable: left > 0, refreshed: false, needsLogin: false }
    }

    if (response.status === 401 || response.status === 403) {
      // 刷新令牌也废了：清掉两个 ref，让上层显式要求重登（别留一个永远 401 的旧令牌）。
      await deps.credentials.unset?.(deps.accessRef)
      await deps.credentials.unset?.(deps.refreshRef)
      report(`刷新令牌被拒（${response.status}）⇒ 已清除本地令牌，需要重新登录`)
      return { usable: false, refreshed: false, needsLogin: true }
    }

    if (!response.ok) {
      report(`刷新令牌失败（HTTP ${response.status}），保留旧令牌稍后重试`)
      return { usable: left > 0, refreshed: false, needsLogin: false }
    }

    let pair: TokenPairLike
    try {
      pair = (await response.json()) as TokenPairLike
    } catch {
      return { usable: left > 0, refreshed: false, needsLogin: false }
    }
    if (typeof pair.accessToken !== 'string' || pair.accessToken === '') {
      report('刷新接口没回 accessToken，保留旧令牌')
      return { usable: left > 0, refreshed: false, needsLogin: false }
    }

    await deps.credentials.set(deps.accessRef, pair.accessToken)
    if (typeof pair.refreshToken === 'string' && pair.refreshToken !== '') {
      await deps.credentials.set(deps.refreshRef, pair.refreshToken)
    }

    report('平台令牌已自动续期')
    return { usable: true, refreshed: true, needsLogin: false }
  }

  return {
    ensureFresh,
    start(everyMs: number): () => void {
      const timer = setInterval(() => {
        void ensureFresh().catch((error: unknown) => {
          report(`续期定时器出错（忽略，下次再试）：${String((error as Error)?.message ?? error)}`)
        })
      }, everyMs)
      // 不阻止进程退出（后台辅助任务）。
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        (timer as { unref?: () => void }).unref?.()
      }
      return () => clearInterval(timer)
    },
  }
}
