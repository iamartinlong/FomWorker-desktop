import { type AuditEntryLike, type ReportContext, type SessionLogRecordLike, toAuditReports, toUsageReports } from './messages.ts'
import type { Reporter } from './reporter.ts'

/**
 * 折叠一个会话并交给上报器：从会话记录折 per-call 用量，从审计条目折审计上报。
 * 纯编排（无 IO）；读日志/读审计由调用方提供（宿主侧接 `office-meter`/`office-audit`）。
 * @param reporter - 上报器。
 * @param sessionId - 会话 id。
 * @param records - 该会话的日志记录。
 * @param ctx - 租户/用户/来源/缺省模型。
 * @param auditEntries - 该会话的审计条目（缺省空）。
 * @returns 入队条数。
 */
export function collectSession(
  reporter: Reporter,
  sessionId: string,
  records: readonly SessionLogRecordLike[],
  ctx: ReportContext,
  auditEntries: readonly AuditEntryLike[] = [],
): number {
  const messages = [...toUsageReports(sessionId, records, ctx), ...toAuditReports(auditEntries, ctx)]
  if (messages.length > 0) reporter.report(messages)
  return messages.length
}
