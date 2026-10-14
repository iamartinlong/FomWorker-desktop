/**
 * 观测指标折叠（M2/E-P2 · `docs/02-设计/平台层设计v0.1.md` §4.3 观测）。
 *
 * 数据源全部是**平台层已采集的**只读事实，无内核新接口：
 * - **审批等待时长**：从审计条目里按 `approval/asked`→`approval/decided`（同会话同 `id`）配对，取
 *   事件信封 `time` 差（`decided.time - asked.time`）；未配到的 `asked` 计 `pending`。
 * - **失败率**：`tool/result` 的 `ok=false` 占比 + 按 `errorCode` 分桶；`turn/end` 的 `reason` 直方图。
 * - **token 趋势**：来自 `office-meter` 的按天汇总（本模块只透传，不重算）。
 *
 * 纯模块：无 IO、无 cordis。
 */

import type { AuditEntry } from '../office-audit/audit.ts'
import { mergeByDay, type SessionUsage, type UsageSummary } from '../office-meter/usage.ts'

/** 审批等待时长统计（ms）。 */
export interface ApprovalLatency {
  /** 已决审批对数。 */
  readonly decided: number
  /** 未配到 `decided` 的 `asked` 数（仍在等）。 */
  readonly pending: number
  /** 平均等待（无已决时为 0）。 */
  readonly avgMs: number
  /** 最长等待（无已决时为 0）。 */
  readonly maxMs: number
}

/** 失败率统计。 */
export interface FailureStats {
  readonly toolCalls: number
  readonly toolResults: number
  readonly toolFailures: number
  /** `toolFailures / toolResults`（无结果为 0）。 */
  readonly failureRate: number
  /** 失败工具结果的错误码直方图（缺码归 `'unknown'`）。 */
  readonly byErrorCode: Readonly<Record<string, number>>
  /** `turn/end` 的 `reason` 直方图。 */
  readonly turnEndByReason: Readonly<Record<string, number>>
}

/** 一类观测指标的汇总。 */
export interface ObserveMetrics {
  readonly approval: ApprovalLatency
  readonly failures: FailureStats
}

/**
 * 从审计条目算审批等待时长。
 * @param entries - 审计条目（同一批采集；跨会话按 `sessionId+id` 配对）。
 * @returns 已决数 / 等待中 / 平均 / 最长（ms）。
 */
export function approvalLatency(entries: readonly AuditEntry[]): ApprovalLatency {
  const asked = new Map<string, number>()
  const waits: number[] = []
  for (const entry of entries) {
    const detail = entry.detail
    if (detail.kind !== 'approval') continue
    const key = `${entry.sessionId}\u0000${detail.id}`
    if (detail.phase === 'asked') asked.set(key, entry.time)
    else {
      const askedAt = asked.get(key)
      if (askedAt !== undefined) {
        waits.push(entry.time - askedAt)
        asked.delete(key)
      }
    }
  }
  const decided = waits.length
  const total = waits.reduce((sum, ms) => sum + ms, 0)
  return {
    decided,
    pending: asked.size,
    avgMs: decided === 0 ? 0 : total / decided,
    maxMs: decided === 0 ? 0 : Math.max(...waits),
  }
}

/**
 * 从审计条目算失败率统计。
 * @param entries - 审计条目。
 * @returns 工具调用/结果/失败计数、失败率、错误码与回合结束原因直方图。
 */
export function failureStats(entries: readonly AuditEntry[]): FailureStats {
  let toolCalls = 0
  let toolResults = 0
  let toolFailures = 0
  const byErrorCode: Record<string, number> = {}
  const turnEndByReason: Record<string, number> = {}
  for (const entry of entries) {
    const detail = entry.detail
    if (detail.kind === 'tool' && detail.phase === 'call') {
      toolCalls += 1
    } else if (detail.kind === 'tool' && detail.phase === 'result') {
      toolResults += 1
      if (!detail.ok) {
        toolFailures += 1
        const code = detail.errorCode ?? 'unknown'
        byErrorCode[code] = (byErrorCode[code] ?? 0) + 1
      }
    } else if (detail.kind === 'turn') {
      turnEndByReason[detail.reason] = (turnEndByReason[detail.reason] ?? 0) + 1
    }
  }
  return {
    toolCalls,
    toolResults,
    toolFailures,
    failureRate: toolResults === 0 ? 0 : toolFailures / toolResults,
    byErrorCode,
    turnEndByReason,
  }
}

/**
 * 从审计条目算观测指标。
 * @param entries - 审计条目。
 * @returns 审批 / 失败的汇总。
 */
export function buildMetrics(entries: readonly AuditEntry[]): ObserveMetrics {
  return { approval: approvalLatency(entries), failures: failureStats(entries) }
}

/** 一个租户的观测快照（控制面/看板读它）。 */
export interface ObserveSnapshot {
  readonly tenant: string
  /** token 按 UTC 日汇总（来自计量）。 */
  readonly tokensByDay: Readonly<Record<string, UsageSummary>>
  readonly metrics: ObserveMetrics
}

/**
 * 合成一个租户的快照。
 * @param tenant - 租户标识。
 * @param sessions - 该租户各会话用量（来自 `office-meter`）。
 * @param entries - 该租户审计条目（来自 `office-audit`）。
 * @returns 快照。
 */
export function buildSnapshot(tenant: string, sessions: readonly SessionUsage[], entries: readonly AuditEntry[]): ObserveSnapshot {
  return { tenant, tokensByDay: mergeByDay(sessions), metrics: buildMetrics(entries) }
}
