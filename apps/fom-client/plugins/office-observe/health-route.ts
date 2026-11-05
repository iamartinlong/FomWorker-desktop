/**
 * 自建健康端点（M2/E-P2 · 平台层 §4.3）：内核 `ctx.webServer` **无内置 `/health`**（P8），
 * 故由本插件在只读 `webServer` 上注册一条 `GET /health`。只吐**非机密**的健康报告（状态 + 依赖在场位）。
 *
 * 与 `office-console` 的目录/状态路由同源：只读、非机密、不经 dsh 的 `/api` token 守卫。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** 健康端点路径。 */
export const HEALTH_ROUTE = '/health'

/** 健康报告。 */
export interface HealthReport {
  readonly status: 'ok' | 'degraded'
  /** 各依赖是否在场（键为依赖名）。 */
  readonly checks: Readonly<Record<string, boolean>>
}

/**
 * 造健康端点的处理函数（与接线拆开，便于单测）。
 * @param report - 产出当前健康报告的回调。
 * @returns 处理函数：`GET` 返回报告（`degraded` → 503）；其余方法 405。
 */
export function createHealthHandler(report: () => HealthReport): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ code: 'method-not-allowed' }))
      return
    }
    const body = report()
    response.writeHead(body.status === 'ok' ? 200 : 503, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(body))
  }
}
