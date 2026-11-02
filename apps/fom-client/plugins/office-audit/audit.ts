/**
 * 审计索引折叠（M2/E-P1 · `docs/02-设计/平台层设计v0.1.md` §4.1 审计）。
 *
 * 事实：内核把**会话事件日志**作为唯一持久真相（`known-event-types.ts`）；审计相关的事件类型有
 * `tool/call`、`tool/result`、`approval/asked`、`approval/decided`、`hook/invoked`、`hook/result`、
 * `permission/preset`、`sandbox/mode`、`model/selection`、`turn/end`（P6）。文件**读**在内核没有专门
 * 事件（P7）⇒ 这里从 `tool/call` 的 `arguments`（JSON 串）**尽力抽取**涉及的路径，作为文件访问审计的
 * 最小信号（dsh-tool-fs 用 `file_path`、搜索工具用 `path`）；完整 diff/写审计仍需数据面埋点（U5，未做）。
 *
 * 纯模块：无 IO、无 cordis。读取器复用 `office-meter` 的 `readSessionLogs`（同一读取口径）。
 *
 * 记录来自**磁盘日志**（durable 边界）⇒ 字段一律运行时校验（`isJsonValue` 级），不信任类型。
 */

import type { SessionLogRecord } from '../office-meter/usage.ts'
import type { SessionLog, SessionLogSet } from '../office-meter/reader.ts'

/** 审计条目类别。 */
export type AuditKind = 'tool' | 'approval' | 'hook' | 'permission' | 'sandbox' | 'model' | 'turn'

/** 归一化审计细目（按 `kind` 判别；`tool`/`approval`/`hook` 另有阶段）。 */
export type AuditDetail =
  | {
      readonly kind: 'tool'
      readonly phase: 'call'
      readonly name: string
      readonly callId: string
      /** 从 `arguments` 尽力抽取的路径（文件访问审计的最小信号；可能为空）。 */
      readonly paths: readonly string[]
    }
  | { readonly kind: 'tool'; readonly phase: 'result'; readonly turn: number; readonly step: number; readonly ok: boolean; readonly errorCode?: string }
  | { readonly kind: 'approval'; readonly phase: 'asked'; readonly id: string; readonly toolName: string; readonly reason?: string }
  | { readonly kind: 'approval'; readonly phase: 'decided'; readonly id: string; readonly outcome: string }
  | { readonly kind: 'hook'; readonly phase: 'invoked' | 'result'; readonly point: string; readonly handlerId: string; readonly decision?: string; readonly durationMs?: number }
  | { readonly kind: 'permission'; readonly preset: string }
  | { readonly kind: 'sandbox'; readonly mode: string }
  | { readonly kind: 'model'; readonly provider: string; readonly model: string }
  | { readonly kind: 'turn'; readonly turn: number; readonly reason: string }

/** 一条审计条目（控制面 DB 的一行）。 */
export interface AuditEntry {
  readonly tenant: string
  readonly sessionId: string
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly detail: AuditDetail
}

/** 条目唯一键（跨采集去重：同一 home 被重复读不重复计数）。 */
export function auditKey(entry: AuditEntry): string {
  return `${entry.tenant}\u0000${entry.sessionId}\u0000${entry.seq}`
}

/** 抽路径时认的参数名（dsh-tool-fs 用 `file_path`；搜索类用 `path`）。 */
const PATH_KEYS = ['file_path', 'path', 'paths', 'files', 'dir', 'directory', 'cwd'] as const

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}

/**
 * 从一次 `tool/call` 的 `arguments`（模型产出的原始 JSON 串）尽力抽取路径。
 * @param argumentsJson - 原始 `arguments` 串（未解析）。
 * @returns 命中的路径（去重前的原序；解析失败或非对象返回空）。
 */
export function extractPaths(argumentsJson: string | undefined): string[] {
  if (argumentsJson === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsJson)
  } catch {
    return []
  }
  const obj = asObject(parsed)
  if (obj === undefined) return []
  const out: string[] = []
  for (const key of PATH_KEYS) {
    const value = obj[key]
    if (typeof value === 'string' && value.length > 0) out.push(value)
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.length > 0) out.push(item)
      }
    }
  }
  return out
}

/** 把一条日志记录映射成审计条目；非审计类事件返回 `undefined`。 */
export function toAuditEntry(record: SessionLogRecord, tenant: string, sessionId: string): AuditEntry | undefined {
  const type = record.type
  if (type === undefined) return undefined
  const data = record.data ?? {}
  const detail = detailOf(type, data)
  if (detail === undefined) return undefined
  return {
    tenant,
    sessionId,
    seq: asNumber(record.seq) ?? 0,
    time: asNumber(record.time) ?? 0,
    type,
    detail,
  }
}

/** 各类事件的归一化（无法解析必填字段则视为不可审计，返回 `undefined`）。 */
function detailOf(type: string, data: Readonly<Record<string, unknown>>): AuditDetail | undefined {
  switch (type) {
    case 'tool/call': {
      const name = asString(data.name)
      if (name === undefined) return undefined
      return { kind: 'tool', phase: 'call', name, callId: asString(data.callId) ?? '', paths: extractPaths(asString(data.arguments)) }
    }
    case 'tool/result': {
      const error = asObject(data.error)
      const errorCode = error === undefined ? undefined : asString(error.code)
      return {
        kind: 'tool',
        phase: 'result',
        turn: asNumber(data.turn) ?? -1,
        step: asNumber(data.step) ?? -1,
        ok: error === undefined,
        ...(errorCode === undefined ? {} : { errorCode }),
      }
    }
    case 'approval/asked': {
      const id = asString(data.id)
      const toolName = asString(data.toolName)
      if (id === undefined || toolName === undefined) return undefined
      const reason = asString(data.reason)
      return { kind: 'approval', phase: 'asked', id, toolName, ...(reason === undefined ? {} : { reason }) }
    }
    case 'approval/decided': {
      const id = asString(data.id)
      const outcome = asString(data.outcome)
      if (id === undefined || outcome === undefined) return undefined
      return { kind: 'approval', phase: 'decided', id, outcome }
    }
    case 'hook/invoked': {
      const point = asString(data.point)
      const handlerId = asString(data.handlerId)
      if (point === undefined || handlerId === undefined) return undefined
      return { kind: 'hook', phase: 'invoked', point, handlerId }
    }
    case 'hook/result': {
      const point = asString(data.point)
      const handlerId = asString(data.handlerId)
      if (point === undefined || handlerId === undefined) return undefined
      const decision = asString(data.decision)
      const durationMs = asNumber(data.durationMs)
      return {
        kind: 'hook',
        phase: 'result',
        point,
        handlerId,
        ...(decision === undefined ? {} : { decision }),
        ...(durationMs === undefined ? {} : { durationMs }),
      }
    }
    case 'permission/preset': {
      const preset = asString(data.preset)
      return preset === undefined ? undefined : { kind: 'permission', preset }
    }
    case 'sandbox/mode': {
      const mode = asString(data.mode)
      return mode === undefined ? undefined : { kind: 'sandbox', mode }
    }
    case 'model/selection': {
      const provider = asString(data.provider)
      const model = asString(data.model)
      if (provider === undefined || model === undefined) return undefined
      return { kind: 'model', provider, model }
    }
    case 'turn/end': {
      const reason = asObject(data.reason)
      return { kind: 'turn', turn: asNumber(data.turn) ?? -1, reason: (reason === undefined ? undefined : asString(reason.kind)) ?? 'unknown' }
    }
    default:
      return undefined
  }
}

/** 折叠一个会话的记录为审计条目（保持日志顺序）。 */
export function foldAudit(log: SessionLog, tenant: string): AuditEntry[] {
  const out: AuditEntry[] = []
  for (const record of log.records) {
    const entry = toAuditEntry(record, tenant, log.sessionId)
    if (entry !== undefined) out.push(entry)
  }
  return out
}

/** 折叠一个 `$DSH_HOME` 的所有会话为审计条目。 */
export function collectAudit(logSet: SessionLogSet, tenant: string): AuditEntry[] {
  const out: AuditEntry[] = []
  for (const log of logSet.sessions) out.push(...foldAudit(log, tenant))
  return out
}
