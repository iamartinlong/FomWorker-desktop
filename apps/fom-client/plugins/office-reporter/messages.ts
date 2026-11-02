/**
 * `office-reporter` —— 客户端→平台**上报消息**的形状与折叠（纯模块）。
 *
 * 契约：`packages/fom-contracts/ws/client-platform.schema.json` 的 `UsageReport` / `AuditReport`。
 * - 用量：**per-call**（幂等键 `{tenant,user,session,turn,step,attempt}`）——`assistant/message` 一律计；
 *   `assistant/attempt` 仅在同 (turn,step) 无已提交 message 时补计（与 `office-meter` 同口径）。
 * - 审计：由 `office-audit` 的 `AuditEntry` 归一化而来（按 `seq` 水位线增量）。
 *
 * 输入用**本地结构类型**（与 `office-meter.SessionLogRecord` / `office-audit.AuditEntry` 结构对齐），
 * 不跨树 import——本模块自包含、无 IO、无 cordis，单测直接调。
 */

/** token 用量（结构视图，对齐内核 `llm` 的 usage 字段）。 */
export interface TokenUsageLike {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

/** 会话日志的一行（结构视图，对齐 `office-meter.SessionLogRecord`）。 */
export interface SessionLogRecordLike {
  readonly type?: string
  readonly seq?: number
  readonly time?: number
  readonly data?: {
    readonly usage?: TokenUsageLike
    readonly turn?: number
    readonly step?: number
    readonly [key: string]: unknown
  }
}

/** 审计条目（结构视图，对齐 `office-audit.AuditEntry`）。 */
export interface AuditEntryLike {
  readonly tenant: string
  readonly sessionId: string
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly detail: unknown
}

/** 上报来源：平台模型（经网关）/ BYO（用户自配）。 */
export type UsageSource = 'platform' | 'byo'

/** 一次调用的用量上报（对齐契约 `UsageReport`）。 */
export interface UsageReport {
  readonly type: 'usage.report'
  readonly tenantId: string
  readonly userId: string
  readonly sessionId: string
  readonly turn: number
  readonly step: number
  readonly attempt: number
  readonly model: string
  readonly source: UsageSource
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  /** ISO 时间。 */
  readonly at: string
}

/** 一条审计上报（对齐契约 `AuditReport`）。 */
export interface AuditReport {
  readonly type: 'audit.report'
  readonly tenantId: string
  readonly userId: string
  readonly sessionId: string
  readonly seq: number
  readonly time: number
  readonly eventType: string
  readonly detail: Record<string, unknown>
}

/** 任意上报消息。 */
export type ReportMessage = UsageReport | AuditReport

/** 折叠上下文（租户/用户/来源/缺省模型）。 */
export interface ReportContext {
  readonly tenantId: string
  readonly userId: string
  readonly source: UsageSource
  /** 记录里没带模型时的缺省。 */
  readonly defaultModel?: string
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function iso(time: unknown): string {
  return new Date(num(time)).toISOString()
}

/**
 * 从**一个会话**的记录折叠出 per-call 用量上报（幂等键口径同 `office-meter`）。
 * @param sessionId - 会话 id。
 * @param records - 该会话的日志记录。
 * @param ctx - 租户/用户/来源/缺省模型。
 * @returns 每条调用一条 `usage.report`。
 */
export function toUsageReports(sessionId: string, records: readonly SessionLogRecordLike[], ctx: ReportContext): UsageReport[] {
  const committed = new Set<string>()
  const key = (turn: unknown, step: unknown): string => `${String(num(turn))}/${String(num(step))}`
  for (const record of records) {
    if (record.type === 'assistant/message' && record.data?.usage !== undefined) {
      committed.add(key(record.data.turn, record.data.step))
    }
  }
  const out: UsageReport[] = []
  for (const record of records) {
    const usage = record.data?.usage
    if (usage === undefined) continue
    const isMessage = record.type === 'assistant/message'
    const isAttempt = record.type === 'assistant/attempt' && !committed.has(key(record.data?.turn, record.data?.step))
    if (!isMessage && !isAttempt) continue
    out.push({
      type: 'usage.report',
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      sessionId,
      turn: num(record.data?.turn),
      step: num(record.data?.step),
      attempt: num(record.data?.attempt),
      model: str(record.data?.model) ?? ctx.defaultModel ?? '',
      source: ctx.source,
      inputTokens: num(usage.inputTokens),
      outputTokens: num(usage.outputTokens),
      cacheReadTokens: num(usage.cacheReadTokens),
      cacheWriteTokens: num(usage.cacheWriteTokens),
      at: iso(record.time),
    })
  }
  return out
}

/**
 * 把审计条目映射成审计上报。
 * @param entries - `office-audit` 的条目。
 * @param ctx - 租户/用户。
 * @returns 每条目一条 `audit.report`。
 */
export function toAuditReports(entries: readonly AuditEntryLike[], ctx: ReportContext): AuditReport[] {
  return entries.map((entry) => ({
    type: 'audit.report',
    tenantId: entry.tenant || ctx.tenantId,
    userId: ctx.userId,
    sessionId: entry.sessionId,
    seq: entry.seq,
    time: entry.time,
    eventType: entry.type,
    detail: (entry.detail ?? {}) as Record<string, unknown>,
  }))
}
