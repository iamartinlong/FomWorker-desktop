/**
 * 审计索引存储（M2/E-P1 · 平台层 §4.1）：控制面把逐 home 折叠出的审计条目收进自己的库，
 * 支持按租户/会话/类别/类型/时间窗查询与 JSONL 导出。
 *
 * 去重键＝`{tenant, sessionId, seq}`（`auditKey`）：因内核无跨进程推送（P11/PE3），控制面按轮询
 * 采集，重复读同一 home 不得重复计数。纯内存实现，持久化由上层（控制面 DB）负责。
 */

import { auditKey, type AuditEntry, type AuditKind } from './audit.ts'

/** 审计查询条件（全部为 AND，缺省即不过滤）。 */
export interface AuditQuery {
  readonly tenant?: string
  readonly sessionId?: string
  readonly kind?: AuditKind
  readonly type?: string
  /** 含：`time >= since`。 */
  readonly since?: number
  /** 含：`time <= until`。 */
  readonly until?: number
  readonly limit?: number
}

/** 审计索引存储面。 */
export interface AuditStore {
  /** 追加条目（按 `{tenant,sessionId,seq}` 去重）；返回真正新增的条数。 */
  add(entries: readonly AuditEntry[]): number
  /** 查询（AND 过滤；结果按 `(time, seq)` 升序）。 */
  query(query?: AuditQuery): AuditEntry[]
  /** 导出 JSONL（按 `(time, seq)` 升序，每行一条）。 */
  exportJsonl(): string
  /** 当前条数。 */
  size(): number
}

function byTimeSeq(a: AuditEntry, b: AuditEntry): number {
  return a.time - b.time || a.seq - b.seq
}

/**
 * 造一个内存审计索引。
 * @returns 可 `add` / `query` / `exportJsonl` / `size` 的存储。
 */
export function createAuditStore(): AuditStore {
  const byKey = new Map<string, AuditEntry>()
  return {
    add(entries): number {
      let added = 0
      for (const entry of entries) {
        const key = auditKey(entry)
        if (byKey.has(key)) continue
        byKey.set(key, entry)
        added += 1
      }
      return added
    },
    query(query = {}): AuditEntry[] {
      let rows = [...byKey.values()]
      const { tenant, sessionId, kind, type, since, until, limit } = query
      if (tenant !== undefined) rows = rows.filter((r) => r.tenant === tenant)
      if (sessionId !== undefined) rows = rows.filter((r) => r.sessionId === sessionId)
      if (kind !== undefined) rows = rows.filter((r) => r.detail.kind === kind)
      if (type !== undefined) rows = rows.filter((r) => r.type === type)
      if (since !== undefined) rows = rows.filter((r) => r.time >= since)
      if (until !== undefined) rows = rows.filter((r) => r.time <= until)
      rows.sort(byTimeSeq)
      return limit !== undefined && rows.length > limit ? rows.slice(0, limit) : rows
    },
    exportJsonl(): string {
      return [...byKey.values()]
        .sort(byTimeSeq)
        .map((entry) => JSON.stringify(entry))
        .join('\n')
    },
    size(): number {
      return byKey.size
    },
  }
}
