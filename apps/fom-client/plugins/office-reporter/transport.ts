import type { ReportMessage } from './messages.ts'

/**
 * 上报传输：把一批消息送到平台。WS 为正式实现（后续 K3），此处先给**内存 mock**。
 * 语义：`send` 成功即视为已送达；抛错则调用方**不 ack**（消息留在离线队列，重连补报）。
 */
export interface ReporterTransport {
  send(messages: readonly ReportMessage[]): Promise<void>
}

/** 内存传输（mock / 单测 / 联调前）。记录所有已发送消息。 */
export function createMemoryTransport(): ReporterTransport & { readonly sent: ReportMessage[] } {
  const sent: ReportMessage[] = []
  return {
    sent,
    async send(messages) {
      for (const message of messages) sent.push(message)
    },
  }
}

/** HTTP 传输的依赖。 */
export interface HttpTransportDeps {
  /** 平台 API 基址（如 `http://localhost:5028`；已去尾斜杠）。 */
  readonly platformUrl: string
  /** 取**客户端访问令牌**（Bearer）；空串则不带（平台会 401）。 */
  readonly token: () => Promise<string> | string
  /** 可注入 fetch（单测）。 */
  readonly fetchImpl?: typeof fetch
}

/**
 * 传输失败（带 HTTP 状态与平台给的退避提示）。
 *
 * 平台对 `/report/*` 按客户端 IP 限流（**429** + `Retry-After`，见 ② N 批）——把状态与提示
 * 带在错误上，调用方才能「退避后再冲」而不是立刻重试。
 */
export class ReportTransportError extends Error {
  /**
   * @param message - 人类可读的失败说明（含路径与状态）。
   * @param status - HTTP 状态码。
   * @param retryAfterMs - 平台 `Retry-After` 解析出的等待毫秒（没有/不可解析 ⇒ undefined）。
   */
  constructor(message: string, readonly status: number, readonly retryAfterMs?: number) {
    super(message)
    this.name = 'ReportTransportError'
  }
}

/**
 * 解析 `Retry-After`：只认**整数秒**（契约里平台就是这么给的）；HTTP-date 与非法值一律 `undefined`
 * （不猜，交给调用方用缺省退避）。
 * @param value - 响应头原值。
 * @returns 等待毫秒或 undefined。
 */
export function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined
  const trimmed = value.trim()
  if (!/^\d+$/u.test(trimmed)) return undefined
  const seconds = Number(trimmed)
  return Number.isSafeInteger(seconds) ? seconds * 1000 : undefined
}

/**
 * 造 **HTTP 传输**：把每条消息 POST 到平台 `/api/report/usage` 或 `/api/report/audit`
 * （契约 `packages/fom-contracts/openapi/platform.yaml`）。凭证＝**客户端访问令牌**（Bearer）。
 *
 * 语义与 `ReporterTransport` 一致：**任一条非 2xx 即抛**（调用方不 ack ⇒ 整批留在队列重试）。
 * **第一条失败就停**：后面的消息**一条都不发**——限流（429）时尤其重要，别把剩下的额度也烧掉；
 * 失败原因带 `status` 与 `Retry-After`（`ReportTransportError`）。
 * @param deps - 平台地址 + 令牌源 + fetch。
 * @returns 传输。
 */
export function createHttpTransport(deps: HttpTransportDeps): ReporterTransport {
  const doFetch = deps.fetchImpl ?? fetch
  const base = deps.platformUrl.replace(/\/+$/u, '')
  return {
    async send(messages) {
      if (messages.length === 0) return
      const token = await deps.token()
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (token !== '') headers.authorization = `Bearer ${token}`
      for (const message of messages) {
        const path = message.type === 'usage.report' ? '/api/report/usage' : '/api/report/audit'
        // 契约体不含判别用的 `type`（平台按端点分流）。
        const { type: _type, ...body } = message
        const res = await doFetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
        if (!res.ok) {
          const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'))
          throw new ReportTransportError(
            `上报失败（${path}）：HTTP ${res.status}${retryAfterMs === undefined ? '' : `（Retry-After ${retryAfterMs / 1000}s）`}`,
            res.status,
            ...(retryAfterMs === undefined ? [] : [retryAfterMs]),
          )
        }
      }
    },
  }
}
