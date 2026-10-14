/**
 * `office-billing` 插件壳（M2/E-P3 · 平台层 §4.2 配额/计费）：把自建价格表的折算与限额裁决以只读服务
 * （`officeBilling`）挂到 context。价格表**自建**（内核不读 cost，P2），经 `Config.prices` 下发；
 * 超额动作经 `Config.overageAction`（默认 `warn`；U3 未定取最保守）。控制面读它出「每租户每日金额」，
 * 并按 `quota()` 的裁决执行超额动作。
 *
 * 无 `inject`（纯折算，不依赖其它服务）。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { costOf, resolvePrice, type CostUsage, type ModelPrice, type PriceTable } from './pricing.ts'
import { OVERAGE_ACTIONS, evaluateQuota, type OverageAction, type QuotaActual, type QuotaLimits, type QuotaVerdict } from './quota.ts'

export * from './pricing.ts'
export * from './quota.ts'

/** 一条待折算项（模型 + 用量）。 */
export interface BilledItem {
  readonly model: string
  readonly usage: CostUsage
}

/** 折算结果。 */
export interface CostBreakdown {
  readonly currency: string
  readonly amount: number
  /** 未定价的模型（不静默按 0 计；调用方应告警）。 */
  readonly unpriced: readonly string[]
}

/** 计费服务面（只读）。 */
export interface OfficeBilling {
  /** 折算单模型一次用量；未定价 ⇒ `undefined`。 */
  cost(model: string, usage: CostUsage): number | undefined
  /** 折算多条项，汇总金额并列出未定价模型。 */
  total(items: readonly BilledItem[]): CostBreakdown
  /** 限额裁决（动作来自配置）。 */
  quota(actual: QuotaActual, limits: QuotaLimits): QuotaVerdict
}

export const name = 'office-billing'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 计费折算 / 限额（只读）。由本插件提供。 */
    officeBilling: OfficeBilling
  }
}

const priceSchema = z.object({
  inputPerMTok: z.number(),
  outputPerMTok: z.number(),
  cacheReadPerMTok: z.number(),
  cacheWritePerMTok: z.number(),
})

/** 配置：币种 + 逐模型单价（每百万 token）+ 超额动作。 */
export interface OfficeBillingConfig {
  currency: string
  prices: Record<string, ModelPrice>
  overageAction: string
}
export const Config: z<OfficeBillingConfig> = z.object({
  currency: z.string().default('USD'),
  prices: z.dict(priceSchema).default({}),
  overageAction: z.string().default('warn'),
})

/** 造计费服务（价格表 + 超额动作，便于单测直接调）。 */
export function createBillingService(table: PriceTable, overage: OverageAction): OfficeBilling {
  return {
    cost: (model, usage) => {
      const price = resolvePrice(table, model)
      return price === undefined ? undefined : costOf(usage, price)
    },
    total: (items) => {
      let amount = 0
      const unpriced: string[] = []
      for (const item of items) {
        const price = resolvePrice(table, item.model)
        if (price === undefined) {
          if (!unpriced.includes(item.model)) unpriced.push(item.model)
          continue
        }
        amount += costOf(item.usage, price)
      }
      return { currency: table.currency, amount, unpriced }
    },
    quota: (actual, limits) => evaluateQuota(actual, limits, overage),
  }
}

/**
 * 把计费服务暴露为 context 服务。
 * @param ctx - 插件上下文。
 * @param config - 配置（`currency`/`prices`/`overageAction`）。
 */
export function apply(ctx: Context, config: OfficeBillingConfig): void {
  if (!(OVERAGE_ACTIONS as readonly string[]).includes(config.overageAction)) {
    throw new Error(`office-billing: overageAction 非法（须为 ${OVERAGE_ACTIONS.join('/')}）：${config.overageAction}`)
  }
  const table: PriceTable = { currency: config.currency, models: config.prices }
  const service = createBillingService(table, config.overageAction as OverageAction)
  ctx.effect(() => ctx.reflect.provide('officeBilling', service))
}

export default { name, Config, apply }
