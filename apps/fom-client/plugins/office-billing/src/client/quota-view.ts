/**
 * 控制台「本周期配额」视图模型（K4 本地配额执行 · **展示**那一半）。
 *
 * 输入＝宿主 `GET /api/office/quota` 的响应（`{ ok, snapshot, verdict }`）。口径照 G6：
 * **权威在网关**，本地只展示「平台记的已用 / 限额」与一个预检结论，**不做任何阻断**。
 * 纯函数（无 DOM、无 fetch），便于单测。
 *
 * 形状**就地声明**（不跨插件 import）：浏览器包只认契约
 * （`packages/fom-contracts/openapi/platform.yaml` 的 `Quota`）与宿主给的那两个字段。
 */

/** 限额（`undefined` ＝ 未设限；与契约「`0` ＝ 未设限」一致）。 */
interface QuotaLimits {
  readonly maxTokens?: number
  readonly maxCost?: number
  readonly maxCalls?: number
}

/** 已用。 */
interface QuotaActual {
  readonly tokens: number
  readonly cost: number
  readonly calls: number
}

/** 一行配额（一个维度）。 */
export interface QuotaRow {
  readonly key: 'tokens' | 'cost' | 'calls'
  readonly label: string
  /** 平台记的已用。 */
  readonly used: number
  /** 限额；`undefined` ＝ 未设限。 */
  readonly limit?: number
  /** 该维超限。 */
  readonly exceeded: boolean
}

/** 配额卡视图。 */
export interface QuotaView {
  /** 拿到过快照 ⇒ true；否则卡片显示「未同步」。 */
  readonly available: boolean
  /** 自然月标识（如 `2026-10`）。 */
  readonly period: string
  readonly rows: readonly QuotaRow[]
  /** 预检结论：`unknown` ＝ 没判过（未同步或平台没给 verdict）。 */
  readonly verdict: 'within' | 'exceeded' | 'unknown'
  /** 一句话说明（未同步 / 正常 / 超限）。 */
  readonly note: string
}

const ROWS: readonly { key: QuotaRow['key']; label: string }[] = [
  { key: 'tokens', label: 'Token' },
  { key: 'cost', label: '金额' },
  { key: 'calls', label: '调用次数' },
]

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 限额维：`> 0` 才算设了限（契约：`0` ＝ 未设限）。 */
function optNum(value: unknown): number | undefined {
  const parsed = num(value)
  return parsed > 0 ? parsed : undefined
}

/**
 * 把宿主响应折成视图。
 * @param payload - `GET /api/office/quota` 的响应体。
 * @param signedIn - 是否已登录（`false` ⇒ 空态文案直接说「未登录」，别让用户以为「没数据」）。
 * `undefined` ⇒ 未探测，按原来的中性文案。
 * @returns 配额卡视图（拿不到就 `available:false`，不编造数字）。
 */
export function quotaView(payload: unknown, signedIn?: boolean): QuotaView {
  const record = asRecord(payload)
  const snapshot = asRecord(record?.snapshot)
  if (record?.ok !== true || snapshot === undefined) {
    const note = signedIn === false
      ? '本地模式（未登录），配额要登录后才拉得到'
      : '还没有配额数据'
    return { available: false, period: '', rows: [], verdict: 'unknown', note }
  }
  const limitsRecord = asRecord(snapshot.limits) ?? {}
  const usedRecord = asRecord(snapshot.used) ?? {}
  const maxTokens = optNum(limitsRecord.maxTokens)
  const maxCost = optNum(limitsRecord.maxCost)
  const maxCalls = optNum(limitsRecord.maxCalls)
  const limits: QuotaLimits = {
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(maxCost === undefined ? {} : { maxCost }),
    ...(maxCalls === undefined ? {} : { maxCalls }),
  }
  const used: QuotaActual = { tokens: num(usedRecord.tokens), cost: num(usedRecord.cost), calls: num(usedRecord.calls) }
  const verdictRecord = asRecord(record.verdict)
  const within = typeof verdictRecord?.within === 'boolean' ? verdictRecord.within : undefined
  const exceeded = new Set((Array.isArray(verdictRecord?.exceeded) ? verdictRecord.exceeded : []).filter((key): key is string => typeof key === 'string'))
  const rows: QuotaRow[] = ROWS.map(({ key, label }) => {
    const limit = key === 'tokens' ? limits.maxTokens : key === 'cost' ? limits.maxCost : limits.maxCalls
    return {
      key,
      label,
      used: key === 'tokens' ? used.tokens : key === 'cost' ? used.cost : used.calls,
      ...(limit === undefined ? {} : { limit }),
      exceeded: exceeded.has(key),
    }
  })
  const verdict = within === undefined ? 'unknown' : within ? 'within' : 'exceeded'
  const period = typeof snapshot.period === 'string' ? snapshot.period : ''
  const note = verdict === 'exceeded' ? '已超限（平台侧为准；本地不阻断）' : verdict === 'within' ? '本周期在限内' : '已同步，平台未给裁决'
  return { available: true, period, rows, verdict, note }
}
