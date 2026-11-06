/**
 * 真实飞书 HTTP 传输：把 `FeishuCall` 打成 `open.feishu.cn` 上的一次请求。
 *
 * 这一层刻意薄到没有逻辑 —— 决策核、卡片形状、重试判据都在 `feishu-channel.ts`，
 * 那里的用例已经用假 transport 钉死了。这里只回答一个问题：**HTTP 响应怎么变成
 * `FeishuReply`**，好让第 6 步攒下的 39 个用例在联调时不用重写就能对上真实网络。
 *
 * 三条落地约束：
 * - **成败看 `code`，不看 HTTP 状态**（官方：im 的业务错误码多数伴随 HTTP 400）。
 *   所以非 2xx 也照样把 `code`/`msg` 原样交出去，让渠道按业务码分支（230009 超窗、
 *   99991663 token 失效都不是抛异常能表达的形状）。
 * - **`path` 原样拼接、不做二次编码**：渠道已经把 `message_id` 插进路径里了，
 *   再 encode 一次会把 `om_xxx` 变成合法的乱码。**只有 query 值**由
 *   `URLSearchParams` 编码。
 * - **超时要当成"可能已送达"**：飞书用 `uuid` 做请求级去重（1 小时至多成功一条），
 *   所以超时后渠道重发会被去重窗口吃掉 —— 这是设计里的正确行为，不是这里要补救的
 *   故障。此处只负责把异常抛出去，不自己偷偷重试：一次调用对应一次网络请求，
 *   重试次数完全归渠道管。
 */

import type { FeishuCall, FeishuReply, FeishuTransport } from './feishu-channel.ts'

export const FEISHU_BASE_URL = 'https://open.feishu.cn'

/** 默认 10 秒：审批卡是要人在同步窗口内点的，传输层不该把窗口耗在自己的挂死上。 */
export const DEFAULT_TIMEOUT_MS = 10_000

/** 网络层失败（连接被拒、DNS 失败、超时、响应体不是 JSON）。与飞书业务码不是一个东西。 */
export class FeishuTransportError extends Error {
  constructor(
    message: string,
    readonly path: string,
    options?: { cause?: unknown },
  ) {
    super(`feishu transport failed at ${path}: ${message}`, options)
    this.name = 'FeishuTransportError'
  }
}

export interface HttpFeishuTransportOptions {
  readonly baseUrl?: string
  readonly timeoutMs?: number
  /** 注入点：用例用小写 fetch 形状替掉真网络。 */
  readonly fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>
}

type JsonBody = {
  readonly code?: unknown
  readonly msg?: unknown
  readonly message?: unknown
  readonly data?: unknown
  readonly tenant_access_token?: unknown
  readonly expire?: unknown
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * 把一次 `FeishuCall` 发出去。
 *
 * 拿到的 `FeishuReply.status` 是真实 HTTP 状态；`code` 在响应体没给业务码时退化成
 * HTTP 状态（成功 0 / 失败原状态），这样渠道的 `reply.code !== 0` 判据对代理返回的
 * HTML 错误页也成立，不会把"网关 502"读成"发送成功"。**读不到 JSON 就 fail closed**：
 * 飞书每个 v2/v3 接口都返回 JSON，拿到非 JSON 说明回答不是飞书给的。
 */
export function createHttpFeishuTransport(options: HttpFeishuTransportOptions = {}): FeishuTransport {
  const base = (options.baseUrl ?? FEISHU_BASE_URL).replace(/\/+$/, '')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init))

  return async (call: FeishuCall): Promise<FeishuReply> => {
    const url = new URL(base + call.path)
    for (const [key, value] of Object.entries(call.query ?? {})) url.searchParams.set(key, value)

    const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' }
    if (call.token !== undefined) headers.Authorization = `Bearer ${call.token}`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()

    let response: Response
    try {
      response = await doFetch(url.toString(), {
        method: call.method,
        headers,
        signal: controller.signal,
        ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
      })
    } catch (error) {
      throw new FeishuTransportError(
        controller.signal.aborted ? `aborted after ${timeoutMs}ms (可能已送达，重发由 uuid 去重兜底)` : String(error),
        call.path,
        { cause: error },
      )
    } finally {
      clearTimeout(timer)
    }

    let body: JsonBody | undefined
    let text: string | undefined
    try {
      text = await response.text()
    } catch (error) {
      throw new FeishuTransportError(`unreadable body (http ${response.status})`, call.path, { cause: error })
    }
    if (text !== undefined && text.length > 0) {
      try {
        const parsed: unknown = JSON.parse(text)
        body = parsed !== null && typeof parsed === 'object' ? (parsed as JsonBody) : undefined
      } catch (error) {
        throw new FeishuTransportError(
          `response is not JSON (http ${response.status}): ${text.slice(0, 120)}`,
          call.path,
          { cause: error },
        )
      }
      if (body === undefined) {
        throw new FeishuTransportError(`response JSON is not an object (http ${response.status})`, call.path)
      }
    }

    const code = asNumber(body?.code, response.ok ? 0 : response.status)
    const msg =
      asString(body?.msg) ??
      asString(body?.message) ??
      (response.ok ? undefined : `http ${response.status} ${response.statusText}`)

    const reply: {
      status: number
      code: number
      msg?: string
      data?: unknown
      tenant_access_token?: string
      expire?: number
    } = { status: response.status, code, msg }
    if (body?.data !== undefined) reply.data = body.data
    if (typeof body?.tenant_access_token === 'string') reply.tenant_access_token = body.tenant_access_token
    if (typeof body?.expire === 'number') reply.expire = body.expire
    return reply
  }
}
