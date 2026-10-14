/**
 * 计费折算（M2/E-P3 · `docs/02-设计/平台层设计v0.1.md` §4.2 配额/计费）。
 *
 * 内核**没有「钱」这维**（P2：无成本/价格，`llm-pi-ai` 明说 harness 从不读 cost metadata）⇒
 * **价格表必须自建**。单价按**每百万 token** 计；计费输入口径沿用内核（三分桶不相交）——
 * `input` 只算未缓存输入，缓存读写单列。
 *
 * 纯模块：无 IO、无 cordis。
 */

/** 一次用量（只取折算需要的分桶）。 */
export interface CostUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

/** 单模型单价（每百万 token；缓存单价缺省 = 输入单价）。 */
export interface ModelPrice {
  readonly inputPerMTok: number
  readonly outputPerMTok: number
  readonly cacheReadPerMTok?: number
  readonly cacheWritePerMTok?: number
}

/** 自建价格表：币种 + 逐模型单价 +（可选）兜底单价。 */
export interface PriceTable {
  readonly currency: string
  readonly models: Readonly<Record<string, ModelPrice>>
  /** 未登记模型的兜底单价（缺省 ⇒ 该模型**未定价**，不静默按 0 计）。 */
  readonly fallback?: ModelPrice
}

function n(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * 解析某模型的单价（先查表，再兜底）。
 * @param table - 价格表。
 * @param model - 模型标识。
 * @returns 单价；未登记且无兜底 ⇒ `undefined`（未定价）。
 */
export function resolvePrice(table: PriceTable, model: string): ModelPrice | undefined {
  return table.models[model] ?? table.fallback
}

/**
 * 折算一次用量的金额。
 * @param usage - 用量。
 * @param price - 该模型的单价。
 * @returns 金额（与价格表同币种）。
 */
export function costOf(usage: CostUsage, price: ModelPrice): number {
  const cacheRead = price.cacheReadPerMTok ?? price.inputPerMTok
  const cacheWrite = price.cacheWritePerMTok ?? price.inputPerMTok
  return (
    n(usage.inputTokens) * price.inputPerMTok +
    n(usage.cacheReadTokens) * cacheRead +
    n(usage.cacheWriteTokens) * cacheWrite +
    n(usage.outputTokens) * price.outputPerMTok
  ) / 1_000_000
}
