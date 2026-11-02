/**
 * 用量折叠与聚合（M2/A2 · 平台层 P0 / 成本 C-P0）。
 *
 * 依据：`docs/02-设计/平台层设计v0.1.md` §4.2 与 `成本治理设计v0.1.md`。
 * 内核落点：会话日志的行是 `SessionEvent` 信封 `{ type, seq, time, data }`；token 用量挂在
 * `assistant/message.data.usage`（**唯一持久的 per-call 用量**），重试经 `assistant/attempt` 单独计费。
 *
 * 折叠规则（**防两侧错**）：
 * - `assistant/message` 的 usage 一律计入；
 * - `assistant/attempt` 的 usage **只在同 (turn,step) 没有 `assistant/message` usage 时**计入
 *   （把「重试但未提交」的尝试补上，又不与提交的那次重复计数）。
 *
 * 纯模块，无 IO、无 cordis；读取器在 `reader.ts`。
 */

/** token 用量（字段对齐内核 `packages/llm/llm/src/types.ts:175-189`）。 */
export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

/** 会话日志的一行（`SessionEvent` 信封的松散视图；只取折叠需要的字段）。 */
export interface SessionLogRecord {
  readonly type?: string
  readonly seq?: number
  readonly time?: number
  readonly data?: {
    readonly usage?: TokenUsage
    readonly turn?: number
    readonly step?: number
    /** 其余事件字段（审计等其它消费者按事件类型自行校验）。 */
    readonly [key: string]: unknown
  }
}

/** 一次折叠的汇总（按会话/按天）。 */
export interface UsageSummary {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
  /** 计费输入 = input + cacheRead + cacheWrite（内核口径：三个桶不相交）。 */
  readonly billedInputTokens: number
}

const EMPTY: UsageSummary = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  billedInputTokens: 0,
})

/** 数字安全取（缺省 0，非有限数按 0）。 */
function n(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 把一次 usage 折进汇总。 */
function add(sum: UsageSummary, usage: TokenUsage): UsageSummary {
  const inputTokens = sum.inputTokens + n(usage.inputTokens)
  const outputTokens = sum.outputTokens + n(usage.outputTokens)
  const cacheReadTokens = sum.cacheReadTokens + n(usage.cacheReadTokens)
  const cacheWriteTokens = sum.cacheWriteTokens + n(usage.cacheWriteTokens)
  const reasoningTokens = sum.reasoningTokens + n(usage.reasoningTokens)
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    billedInputTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
  }
}

/** 一次会话的用量 + 元信息。 */
export interface SessionUsage {
  readonly sessionId: string
  readonly summary: UsageSummary
  /** 每个 `assistant/message` 事件按 `time` 归到的 UTC 日（`YYYY-MM-DD`）→ 该日汇总。 */
  readonly byDay: Readonly<Record<string, UsageSummary>>
}

function utcDay(time: number | undefined): string {
  const ms = typeof time === 'number' && Number.isFinite(time) ? time : 0
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * 从**一个会话**的日志记录折叠用量。
 * @param sessionId - 会话 id（仅作标识）。
 * @param records - 该会话的日志记录（顺序无关）。
 * @returns 会话用量汇总 + 按 UTC 日拆分。
 */
export function foldSessionUsage(sessionId: string, records: readonly SessionLogRecord[]): SessionUsage {
  const committed = new Set<string>()
  const key = (turn: number | undefined, step: number | undefined): string => `${String(turn ?? -1)}/${String(step ?? -1)}`

  // 第一遍：登记已提交（带 usage 的 assistant/message）的 (turn,step)。
  for (const record of records) {
    if (record.type === 'assistant/message' && record.data?.usage !== undefined) {
      committed.add(key(record.data.turn, record.data.step))
    }
  }

  // 第二遍：累加 + 按天。
  let summary = EMPTY
  const byDay: Record<string, UsageSummary> = {}
  const accumulate = (time: number | undefined, usage: TokenUsage): void => {
    summary = add(summary, usage)
    const day = utcDay(time)
    byDay[day] = add(byDay[day] ?? EMPTY, usage)
  }
  for (const record of records) {
    const usage = record.data?.usage
    if (usage === undefined) continue
    if (record.type === 'assistant/message') {
      accumulate(record.time, usage)
    } else if (record.type === 'assistant/attempt' && !committed.has(key(record.data?.turn, record.data?.step))) {
      accumulate(record.time, usage)
    }
  }
  return { sessionId, summary, byDay }
}

/**
 * 把多个会话的按天用量合并成一张「日 → 汇总」表。
 * @param sessions - 各会话用量。
 * @returns UTC 日 → 汇总（跨会话相加）。
 */
export function mergeByDay(sessions: readonly SessionUsage[]): Record<string, UsageSummary> {
  const out: Record<string, UsageSummary> = {}
  for (const session of sessions) {
    for (const [day, summary] of Object.entries(session.byDay)) {
      out[day] = {
        inputTokens: (out[day]?.inputTokens ?? 0) + summary.inputTokens,
        outputTokens: (out[day]?.outputTokens ?? 0) + summary.outputTokens,
        cacheReadTokens: (out[day]?.cacheReadTokens ?? 0) + summary.cacheReadTokens,
        cacheWriteTokens: (out[day]?.cacheWriteTokens ?? 0) + summary.cacheWriteTokens,
        reasoningTokens: (out[day]?.reasoningTokens ?? 0) + summary.reasoningTokens,
        billedInputTokens: (out[day]?.billedInputTokens ?? 0) + summary.billedInputTokens,
      }
    }
  }
  return out
}
