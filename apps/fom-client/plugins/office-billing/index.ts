/**
 * `office-billing` 插件壳（M2/E-P3 · 平台层 §4.2 配额/计费）：把自建价格表的折算与限额裁决以只读服务
 * （`officeBilling`）挂到 context。价格表**自建**（内核不读 cost，P2），经 `Config.prices` 下发；
 * 超额动作经 `Config.overageAction`（默认 `warn`；U3 未定取最保守）。
 *
 * **本地配额执行（K4，2026-10-17）**：`/api/config/quota` 下发拉到本地 → `precheckQuota()` 判一个
 * verdict 给人看。口径照 G6（`整体方案总览v0.2` §16）：**权威在网关**，本地只「预检 + 展示」、
 * **不硬拦**；BYO 默认不设限（限额全 0 时 verdict 恒 `within`）。
 *
 * 无内核依赖；路由经 `connection`（认证的 `/api` 通道），令牌取自 `ctx.credentials`。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { costOf, resolvePrice, type CostUsage, type ModelPrice, type PriceTable } from './pricing.ts'
import { OVERAGE_ACTIONS, evaluateQuota, type OverageAction, type QuotaActual, type QuotaLimits, type QuotaVerdict } from './quota.ts'
import { fetchQuota, QUOTA_PATH, type QuotaSnapshot } from './platform.ts'

export * from './pricing.ts'
export * from './quota.ts'
export * from './platform.ts'

/** 一条待折算项（模型 + 用量）。 */
export interface BilledItem {
  readonly model: string
  readonly usage: CostUsage
}

/** 折算结果。 */
export interface CostBreakdown {
  readonly currency: string
  readonly amount: number
  /** 未定价的模型（不静默按 0 计；调用方应告警）。 */
  readonly unpriced: readonly string[]
}

/** 本地配额面（预检 + 展示；不硬拦——权威在网关）。 */
export interface OfficeQuota {
  /** 最近一次拉到的快照；从没拉到过 ⇒ `undefined`。 */
  snapshot(): QuotaSnapshot | undefined
  /** 拉平台配额（`/api/config/quota`）并记为最新快照。 */
  sync(): Promise<QuotaSnapshot>
  /** 按最新快照判一次（未同步过 ⇒ `undefined`；只判不拦）。 */
  precheck(): QuotaVerdict | undefined
}

/** 计费服务面（只读）。 */
export interface OfficeBilling {
  /** 折算单模型一次用量；未定价 ⇒ `undefined`。 */
  cost(model: string, usage: CostUsage): number | undefined
  /** 折算多条项，汇总金额并列出未定价模型。 */
  total(items: readonly BilledItem[]): CostBreakdown
  /** 限额裁决（动作来自配置）。 */
  quota(actual: QuotaActual, limits: QuotaLimits): QuotaVerdict
  /** 本地配额快照（未接平台/没同步过 ⇒ `undefined`）。 */
  quotaSnapshot(): QuotaSnapshot | undefined
  /** 拉平台配额（未接平台 ⇒ 抛）。 */
  syncQuota(): Promise<QuotaSnapshot>
  /** 本地预检（未接平台/没同步过 ⇒ `undefined`）。 */
  precheckQuota(): QuotaVerdict | undefined
}

export const name = 'office-billing'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 计费折算 / 限额（只读）。由本插件提供。 */
    officeBilling: OfficeBilling
  }
}

const priceSchema = z.object({
  inputPerMTok: z.number(),
  outputPerMTok: z.number(),
  cacheReadPerMTok: z.number(),
  cacheWritePerMTok: z.number(),
})

/** 配置：币种 + 逐模型单价（每百万 token）+ 超额动作 + 平台地址（本地配额执行）。 */
export interface OfficeBillingConfig {
  currency: string
  prices: Record<string, ModelPrice>
  overageAction: string
  /** 平台 API 基址（`/api/config/quota` 用；缺省本机 dev）。 */
  platformUrl: string
}
export const Config: z<OfficeBillingConfig> = z.object({
  currency: z.string().default('USD'),
  prices: z.dict(priceSchema).default({}),
  overageAction: z.string().default('warn'),
  platformUrl: z.string().default('http://localhost:5028'),
})

/** 平台令牌的凭据 ref（与 `office-login`/`office-skills` 同一名；跨插件不引值，故各自声明）。 */
export const PLATFORM_TOKEN_REF = 'FOM_PLATFORM_TOKEN'

/** 配额同步路由（认证的 `/api` 通道；写）。 */
export const QUOTA_SYNC_ROUTE = '/api/office/quota/sync'

/** 配额读路由（认证的 `/api` 通道；给控制台展示）。 */
export const QUOTA_READ_ROUTE = '/api/office/quota'

/** `connection` 服务的最小面（认证 Fetch 路由）。 */
interface ConnectionLike {
  fetch: {
    register(route: {
      path: string
      methods: readonly string[]
      requestBody: 'buffered' | 'streaming'
      fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

/** 本地配额服务的依赖。 */
export interface QuotaServiceDeps {
  /** 平台 API 基址（已去尾斜杠）。 */
  readonly platformUrl: string
  /** 取客户端访问令牌。 */
  readonly token: () => Promise<string> | string
  /** 超额动作（判 verdict 时回显；默认 `warn`）。 */
  readonly action?: OverageAction
  /** 可注入 fetch（单测）。 */
  readonly fetchImpl?: typeof fetch
}

/**
 * 造**本地配额服务**（预检 + 展示；不硬拦）：拉 `/api/config/quota` 存最新快照，
 * `precheck()` 用「平台记的已用」对照限额判一次（G6：权威在网关，本地只提示）。
 * @param deps - 平台地址 + 令牌源 + 动作 + fetch。
 * @returns 配额服务面。
 */
export function createQuotaService(deps: QuotaServiceDeps): OfficeQuota {
  const action = deps.action ?? 'warn'
  let latest: QuotaSnapshot | undefined
  return {
    snapshot: () => latest,
    async sync() {
      const snapshot = await fetchQuota({
        platformUrl: deps.platformUrl,
        token: deps.token,
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      })
      latest = snapshot
      return snapshot
    },
    precheck: () => latest === undefined ? undefined : evaluateQuota(latest.used, latest.limits, action),
  }
}

/**
 * 造计费服务（价格表 + 超额动作 + 可选的本地配额面，便于单测直接调）。
 * @param table - 价格表。
 * @param overage - 超额动作。
 * @param quota - 本地配额面（不给 ⇒ 三个配额方法返回 `undefined`）。
 * @returns 计费服务面。
 */
export function createBillingService(table: PriceTable, overage: OverageAction, quota?: OfficeQuota): OfficeBilling {
  return {
    cost: (model, usage) => {
      const price = resolvePrice(table, model)
      return price === undefined ? undefined : costOf(usage, price)
    },
    total: (items) => {
      let amount = 0
      const unpriced: string[] = []
      for (const item of items) {
        const price = resolvePrice(table, item.model)
        if (price === undefined) {
          if (!unpriced.includes(item.model)) unpriced.push(item.model)
          continue
        }
        amount += costOf(item.usage, price)
      }
      return { currency: table.currency, amount, unpriced }
    },
    quota: (actual, limits) => evaluateQuota(actual, limits, overage),
    quotaSnapshot: () => quota?.snapshot(),
    syncQuota: () => quota === undefined ? Promise.reject(new Error('office-billing: 未接平台（platformUrl 未配）')) : quota.sync(),
    precheckQuota: () => quota?.precheck(),
  }
}

/**
 * 把计费服务暴露为 context 服务，并挂两条认证 `/api` 路由（配额同步 / 配额读）。
 * @param ctx - 插件上下文。
 * @param config - 配置（`currency`/`prices`/`overageAction`/`platformUrl`）。
 * @param deps - 测试缝：可注入 `fetch`（生产不传）。
 */
export function apply(ctx: Context, config: OfficeBillingConfig, deps: { fetchImpl?: typeof fetch } = {}): void {
  if (!(OVERAGE_ACTIONS as readonly string[]).includes(config.overageAction)) {
    throw new Error(`office-billing: overageAction 非法（须为 ${OVERAGE_ACTIONS.join('/')}）：${config.overageAction}`)
  }
  const table: PriceTable = { currency: config.currency, models: config.prices }
  const overage = config.overageAction as OverageAction
  const platformUrl = config.platformUrl.replace(/\/+$/u, '')
  /** 令牌从宿主凭据库取（与 `office-login` 写入的是同一 ref）。 */
  const token = async (): Promise<string> => {
    const credentials = ctx.get('credentials') as { resolve?: (ref: string) => Promise<{ value: string } | undefined> } | undefined
    return (await credentials?.resolve?.(PLATFORM_TOKEN_REF))?.value ?? ''
  }
  const quota = createQuotaService({
    platformUrl,
    token,
    action: overage,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  })
  const service = createBillingService(table, overage, quota)
  ctx.effect(() => ctx.reflect.provide('officeBilling', service))

  ctx.inject(['connection'], (connCtx) => {
    connCtx.effect(() => {
      const conn = connCtx.get('connection') as ConnectionLike | undefined
      if (conn === undefined) return () => {}
      const json = (body: unknown, status = 200): Response =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      const disposeSync = conn.fetch.register({
        path: QUOTA_SYNC_ROUTE,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async () => {
          const current = ctx.get('officeBilling') as OfficeBilling | undefined
          if (current === undefined) return json({ ok: false, message: 'officeBilling 服务缺失' }, 500)
          try {
            const snapshot = await current.syncQuota()
            return json({ ok: true, ...snapshot })
          } catch (error) {
            return json({ ok: false, message: String((error as Error)?.message ?? error) })
          }
        },
      })
      const disposeRead = conn.fetch.register({
        path: QUOTA_READ_ROUTE,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => {
          const current = ctx.get('officeBilling') as OfficeBilling | undefined
          if (current === undefined) return json({ ok: false, message: 'officeBilling 服务缺失' }, 500)
          return json({ ok: true, snapshot: current.quotaSnapshot() ?? null, verdict: current.precheckQuota() ?? null })
        },
      })
      return () => {
        void disposeRead()
        void disposeSync()
      }
    }, 'office-billing: 配额路由（同步 / 读）')
  })
}

/** 下发给调用方的契约路径（供文档/联调引用）。 */
export { QUOTA_PATH }

export default { name, Config, apply }
