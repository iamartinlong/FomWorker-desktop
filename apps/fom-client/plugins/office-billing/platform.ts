/**
 * **平台配额下发**（G6 本地那一半）：把 `GET /api/config/quota` 的 DTO 归一成 `QuotaSnapshot`。
 *
 * 口径（`整体方案总览v0.2` §16 G6）：**权威在网关**——本地只做「预检 + 展示」，**不硬拦**；
 * 所以这里只负责把限额与已用拉下来、判一个 verdict 给人看，不做任何阻断。
 * 契约（`packages/fom-contracts/openapi/platform.yaml`）：限额 `0` ＝ **未设限**（⇒ `undefined`，
 * 不参与判定）；`period` 是自然月标识（如 `2026-10`）。
 *
 * 纯函数 + fetch（无内核类型、无 cordis）；令牌与地址由调用方给。
 */

import type { QuotaActual, QuotaLimits } from './quota.ts'

/** 配额下发路径（契约 `GET /config/quota`）。 */
export const QUOTA_PATH = '/api/config/quota'

/** 一次配额快照（下发 DTO 归一后的形状）。 */
export interface QuotaSnapshot {
  /** 自然月标识（如 `2026-10`）。 */
  readonly period: string
  /** 限额（`0` ＝ 未设限 ⇒ 该维缺席）。 */
  readonly limits: QuotaLimits
  /** 平台记的本周期已用。 */
  readonly used: QuotaActual
  /** 拉到时刻（毫秒；展示「数据有多旧」用）。 */
  readonly fetchedAt: number
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 限额维：`> 0` 才算设了限（契约：`0` ＝ 未设限）。 */
function limit(value: unknown): number | undefined {
  const parsed = number(value)
  return parsed > 0 ? parsed : undefined
}

/**
 * 把下发 DTO 归一成快照。**响亮**：不是对象 ⇒ 抛（不静默当成「未设限」，那会把故障伪装成正常）。
 * @param dto - `/api/config/quota` 的响应体。
 * @param fetchedAt - 拉到时刻（缺省现在；单测注入用）。
 * @returns 快照。
 */
export function quotaFromDto(dto: unknown, fetchedAt: number = Date.now()): QuotaSnapshot {
  const record = asRecord(dto)
  if (record === undefined) throw new Error('配额下发：响应不是对象')
  const limits: QuotaLimits = {}
  const maxTokens = limit(record.maxTokens)
  const maxCost = limit(record.maxCost)
  const maxCalls = limit(record.maxCalls)
  return {
    period: typeof record.period === 'string' ? record.period : '',
    limits: {
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(maxCost === undefined ? {} : { maxCost }),
      ...(maxCalls === undefined ? {} : { maxCalls }),
    },
    used: {
      tokens: number(record.usedTokens),
      cost: number(record.usedCost),
      calls: number(record.usedCalls),
    },
    fetchedAt,
  }
}

/** `fetchQuota` 的依赖。 */
export interface FetchQuotaDeps {
  /** 平台 API 基址（如 `http://localhost:5028`；已去尾斜杠）。 */
  readonly platformUrl: string
  /** 取**客户端访问令牌**（Bearer）；空串则不带（平台会 401）。 */
  readonly token: () => Promise<string> | string
  /** 可注入 fetch（单测）。 */
  readonly fetchImpl?: typeof fetch
  /** 拉到时刻（单测注入用）。 */
  readonly now?: () => number
}

/**
 * 拉平台配额（`GET /api/config/quota`，Bearer＝客户端访问令牌）。
 * **非 2xx 即抛**（调用方据此把快照判为「没拉到」，不拿旧值冒充新值）。
 * @param deps - 平台地址 + 令牌源 + fetch。
 * @returns 配额快照。
 */
export async function fetchQuota(deps: FetchQuotaDeps): Promise<QuotaSnapshot> {
  const doFetch = deps.fetchImpl ?? fetch
  const base = deps.platformUrl.replace(/\/+$/u, '')
  const token = await deps.token()
  const headers: Record<string, string> = { accept: 'application/json' }
  if (token !== '') headers.authorization = `Bearer ${token}`
  const res = await doFetch(`${base}${QUOTA_PATH}`, { headers })
  if (!res.ok) throw new Error(`平台配额下发失败：HTTP ${res.status}`)
  return quotaFromDto(await res.json(), deps.now?.() ?? Date.now())
}
