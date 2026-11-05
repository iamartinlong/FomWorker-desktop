/**
 * `office-observe` 插件壳（M2/E-P2 · 平台层 §4.3 观测）：把逐租户的观测快照（审批等待时长 / 失败率 /
 * token 趋势）以只读服务（`officeObserve`）挂到 context，并在 `webServer` 上自建 `GET /health`（内核无，P8）。
 *
 * 依赖 `officeMeter`（token 趋势）与 `officeAudit`（审批/失败）两个现成只读服务——两者都由本平台提供；
 * 服务不齐则本层不装（装配错误，不是放宽）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { buildMetrics, buildSnapshot, type ObserveMetrics, type ObserveSnapshot } from './observe.ts'
import { HEALTH_ROUTE, createHealthHandler } from './health-route.ts'
import type { OfficeMeter } from '../office-meter/index.ts'
import type { OfficeAudit } from '../office-audit/index.ts'
import type { AuditEntry } from '../office-audit/audit.ts'

export * from './observe.ts'
export * from './health-route.ts'

/** `webServer` 服务的最小面：只要 `register`，不依赖内核包的类型导出。 */
interface WebServerLike {
  register: (route: {
    kind: 'exact'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }) => () => void
}

/** 观测服务面（只读）。 */
export interface OfficeObserve {
  /** 从审计条目算观测指标（纯，便于单测）。 */
  metrics(entries: readonly AuditEntry[]): ObserveMetrics
  /** 采一个租户的 home → 快照（token 趋势来自计量，审批/失败来自审计）。 */
  snapshot(homeDir: string, tenant: string): ObserveSnapshot
}

export const name = 'office-observe'
export const inject = ['officeMeter', 'officeAudit']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 观测快照（只读）。由本插件提供。 */
    officeObserve: OfficeObserve
  }
}

/** 造观测服务（依赖注入，便于单测直接调）。 */
export function createObserveService(meter: OfficeMeter, audit: OfficeAudit): OfficeObserve {
  return {
    metrics: (entries) => buildMetrics(entries),
    snapshot: (homeDir, tenant) => {
      const usage = meter.collect(homeDir)
      const entries = audit.collect(homeDir, tenant)
      return buildSnapshot(tenant, usage.sessions, entries)
    },
  }
}

/**
 * 暴露观测服务为 context 服务，并在 `webServer` 上挂 `GET /health`。
 * @param ctx - 插件上下文。
 */
export function apply(ctx: Context): void {
  const meter = ctx.get('officeMeter')
  if (meter === undefined) throw new Error('office-observe: officeMeter 服务缺失（需与 office-meter 一起挂）')
  const audit = ctx.get('officeAudit')
  if (audit === undefined) throw new Error('office-observe: officeAudit 服务缺失（需与 office-audit 一起挂）')
  const service = createObserveService(meter, audit)
  ctx.effect(() => ctx.reflect.provide('officeObserve', service))
  // `webServer` 在 apply 时刻还没就位（实测），经 `ctx.inject` 等它就绪再挂；CLI 形态下不激活就不挂。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const server = webCtx.get('webServer') as WebServerLike | undefined
      if (server === undefined) return () => {}
      const unregister = server.register({
        kind: 'exact',
        path: HEALTH_ROUTE,
        handler: createHealthHandler(() => ({ status: 'ok', checks: { meter: true, audit: true } })),
      })
      return () => { unregister() }
    }, 'office-observe: 健康端点')
  })
}

export default { name, inject, apply }
