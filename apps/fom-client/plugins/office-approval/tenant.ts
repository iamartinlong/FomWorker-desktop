/**
 * **闸的租户解析**：桌面形态下租户不是常量，而是**登录后平台令牌 JWT 里的 `tenant_id`**。
 *
 * 闸的 `tenantOf(sessionId)` 是**同步**接口，而读凭据是异步的 ⇒ 这里做一层**缓存 + 按需刷新**：
 * `current()` 同步给缓存（顺手在过期时后台刷一次），`refresh()` 真正去读令牌并解 JWT。
 *
 * 三条取向：
 * - **解不出来就 `undefined`**（⇒ 闸交棒 `next()`）：没登录/令牌坏掉时，我们这一层**不替它决定**，
 *   既不拿一个假租户去记账，也不放行 —— 内核自己那道闸照旧在（与 `risk-gate.ts` 的 `tenantOf` 契约一致）。
 * - `fixed`（配置里写了 `tenantId`）⇒ **恒用它**，不读凭据：M1 / 单租户形态照旧。
 * - 读凭据**出错**时**保留旧值**（瞬时故障不该把已登录的人打回未登录），但令牌**空**⇒ 立刻清空（登出）。
 *
 * 纯逻辑（读令牌与解 JWT 由调用方注入），可不起 cordis 直接单测。
 */

/** 租户解析器。 */
export interface TenantResolver {
  /** 同步读当前租户；解不出来 ⇒ `undefined`（调用方据此交棒）。 */
  current(): { tenantId: string } | undefined
  /** 去读令牌并重解租户（起手与过期时各刷一次）。 */
  refresh(): Promise<void>
}

export interface TenantResolverDeps {
  /** 配置里写死的租户（非空 ⇒ 恒用它，不读凭据）。 */
  readonly fixed?: string
  /** 读平台令牌（空串＝没登录）。 */
  readonly readToken: () => Promise<string>
  /** 从令牌解租户（解不出 ⇒ undefined）。 */
  readonly parseTenant: (token: string) => string | undefined
  /** 时钟（单测）。 */
  readonly now?: () => number
  /** 缓存有效期（毫秒，缺省 10 秒）：过期后 `current()` 会顺手后台刷一次。 */
  readonly ttlMs?: number
  /** 刷新失败的上报口（不抛：闸那一侧要的是「解不出来就交棒」）。 */
  readonly onError?: (error: unknown) => void
}

/**
 * 造租户解析器。
 * @param deps - 固定租户（可选）+ 读令牌 + 解令牌 + 时钟/TTL/上报口。
 * @returns 同步读 + 异步刷新。
 */
export function createTenantResolver(deps: TenantResolverDeps): TenantResolver {
  const fixed = deps.fixed ?? ''
  if (fixed !== '') {
    return { current: () => ({ tenantId: fixed }), refresh: () => Promise.resolve() }
  }
  const now = deps.now ?? (() => Date.now())
  const ttlMs = deps.ttlMs ?? 10_000
  let cached: string | undefined
  let refreshedAt = Number.NEGATIVE_INFINITY
  let inflight: Promise<void> | undefined

  const refresh = async (): Promise<void> => {
    try {
      const token = await deps.readToken()
      // 令牌空 ⇒ 登出：立刻清空（旧租户不能继续用）。
      cached = token === '' ? undefined : deps.parseTenant(token)
      refreshedAt = now()
    } catch (error) {
      // 读凭据出错：保留旧值（瞬时故障不打回未登录），只上报。
      deps.onError?.(error)
    }
  }

  return {
    current() {
      if (now() - refreshedAt > ttlMs) {
        // 过期（含起手）⇒ 后台刷一次；本次仍按缓存答（第一次可能还没有 ⇒ 交棒，下几毫秒就有了）。
        inflight ??= refresh().finally(() => { inflight = undefined })
      }
      return cached === undefined ? undefined : { tenantId: cached }
    },
    async refresh() {
      inflight ??= refresh().finally(() => { inflight = undefined })
      await inflight
    },
  }
}
