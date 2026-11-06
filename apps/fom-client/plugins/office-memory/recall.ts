/**
 * 读侧打分（设计 DM6 / §3.4，实现顺序第 4 步）。
 *
 * 这个内核零 embedding（MF10），所以「检索」只有词法一条腿，打分只出现在两处：
 * ① 常驻索引超预算时先裁谁，② 蒸馏淘汰老条目时的候选次序。全文那一路直接用内核 FTS5 的
 * `rank`，不自造分数 —— 这里给的分数**只服务上面两处**，不是第三条检索路径。
 *
 * 关键分工：**注入侧的裁剪只用类型权重，不看时间**（`inject.ts`）。原因见 ME5 —— 常驻索引
 * 「不受打分影响」才是对的：一个 60 天前的重要 feedback 不该因为 `exp(-Δ/τ)` 而从天天的索引里
 * 消失。真正要用到时间衰减的是蒸馏淘汰与召回排序（老且低权重的先出局、近的排前面），
 * 那才是要把 `exp(-Δ天/τ)` 乘进去的地方。
 */

import { MEMORY_TYPES, type MemoryType } from './store.ts'

/** 类型权重（ME5：`user` / `feedback` 高于 `project` 高于 `reference`）。 */
export const TYPE_WEIGHTS: Readonly<Record<MemoryType, number>> = {
  user: 4,
  feedback: 3,
  project: 2,
  reference: 1,
}

/** 时间衰减常数 τ（天）。默认 30 天（DM6）。 */
export const DEFAULT_TAU_DAYS = 30

/** 索引一行的形状（DM2：`- [标题](类型/文件.md) — 一句话钩子`）里的路径段解析。 */
const ENTRY_LINE = /^- \[[^\]]*\]\(([^/]+)\/[^)]+\)/

/** 这行是不是一条可打分的条目行；是则回它的类型，否则 undefined。 */
export function entryTypeFromLine(line: string): MemoryType | undefined {
  const match = ENTRY_LINE.exec(line)
  const type = match?.[1]
  return type !== undefined && (MEMORY_TYPES as readonly string[]).includes(type) ? (type as MemoryType) : undefined
}

/**
 * 命中密度：查询词里有多少出现在这条索引文本里（0–1）。没有查询词时记 1 ——
 * 常驻索引这一路本就无查询，密度项不该参与（见 §3.4：分数只在「超预算裁谁」与蒸馏淘汰两处，
 * 而注入裁那一处根本不用时间密度，只用权重）。
 */
export function hitDensity(queryTerms: readonly string[], indexText: string): number {
  if (queryTerms.length === 0) return 1
  const haystack = indexText.toLowerCase()
  let matched = 0
  for (const term of queryTerms) {
    const needle = term.trim().toLowerCase()
    if (needle !== '' && haystack.includes(needle)) matched += 1
  }
  return matched / queryTerms.length
}

export interface ScoreInput {
  readonly type: MemoryType
  /** 距今多少天（可为负=未来时钟漂移，按 0 处理，不让一条写歪的 createdAt 反而加权）。 */
  readonly ageDays: number
  readonly queryTerms?: readonly string[]
  /** 参与命中密度匹配的文本 = 标题 + 钩子（读侧不碰正文，§3.4「按需 read」）。 */
  readonly indexText?: string
}

/**
 * `类型权重 × exp(-Δ天/τ) × 命中密度`（DM6）。τ 与权重表可注入，方便蒸馏与测试用同一函数。
 * 返回非负；越近、越重、越命中越大。
 */
export function memoryScore(
  input: ScoreInput,
  options: { tauDays?: number; weights?: Readonly<Record<MemoryType, number>> } = {},
): number {
  const tau = options.tauDays ?? DEFAULT_TAU_DAYS
  const weights = options.weights ?? TYPE_WEIGHTS
  const age = Math.max(0, input.ageDays)
  const recency = Math.exp(-age / tau)
  const density = hitDensity(input.queryTerms ?? [], input.indexText ?? '')
  const weight = weights[input.type] ?? 1
  return weight * recency * density
}
