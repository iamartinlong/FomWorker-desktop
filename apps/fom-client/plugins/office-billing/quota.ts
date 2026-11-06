/**
 * 限额与超额（M2/E-P3 · 平台层 §4.2）：plan → 限额（token/金额/调用次数）；超额动作三选一
 * （拒新 turn / 降级便宜模型 / 只告警）。**U3 未定** ⇒ 默认取**只告警**（最保守、不阻断既有工作），
 * 由配置显式改；判定与实际执行分离（本模块只判，动作由控制面按 verdict 执行）。
 *
 * 纯模块：无 IO、无 cordis。
 */

/** 超额动作（U3 三选一；默认 `warn`）。 */
export type OverageAction = 'warn' | 'reject' | 'downgrade'

/** 全部合法超额动作（配置校验用）。 */
export const OVERAGE_ACTIONS: readonly OverageAction[] = ['warn', 'reject', 'downgrade']

/** 限额（缺省即不限制该维）。 */
export interface QuotaLimits {
  readonly maxTokens?: number
  readonly maxCost?: number
  readonly maxCalls?: number
}

/** 实际用量（对照限额）。 */
export interface QuotaActual {
  readonly tokens: number
  readonly cost: number
  readonly calls: number
}

/** 限额裁决。 */
export interface QuotaVerdict {
  /** 全部维度都未超 ⇒ true。 */
  readonly within: boolean
  /** 超出的维度（空 ⇒ 未超）。 */
  readonly exceeded: readonly ('tokens' | 'cost' | 'calls')[]
  /** 超限时采取的动作（来自配置；未超时也回显，便于调用方记录）。 */
  readonly action: OverageAction
}

/**
 * 对照限额判超额。
 * @param actual - 实际用量。
 * @param limits - 限额（缺省维不判）。
 * @param action - 超限动作（默认 `warn`）。
 * @returns 裁决：是否在限内 + 超出的维度 + 动作。
 */
export function evaluateQuota(actual: QuotaActual, limits: QuotaLimits, action: OverageAction = 'warn'): QuotaVerdict {
  const exceeded: ('tokens' | 'cost' | 'calls')[] = []
  if (limits.maxTokens !== undefined && actual.tokens > limits.maxTokens) exceeded.push('tokens')
  if (limits.maxCost !== undefined && actual.cost > limits.maxCost) exceeded.push('cost')
  if (limits.maxCalls !== undefined && actual.calls > limits.maxCalls) exceeded.push('calls')
  return { within: exceeded.length === 0, exceeded, action }
}
