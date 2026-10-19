/**
 * `office-login` 的 node half（K1 + K2）。
 *
 * **K1（登录代理）**：浏览器**不直连平台**（平台不开 CORS，见 `交接文档` §7）⇒ 宿主在服务端调
 * 平台 `/api/auth/login`，拿到令牌后写**宿主凭据库** `ctx.credentials`（ref `FOM_PLATFORM_TOKEN`），
 * **只把 `user` 回给前端**（令牌不过浏览器）。
 * **K2**：写 `llm-pi-ai.providers.<id>` = `{ baseURL: <网关>, apiKeyEnv: FOM_PLATFORM_TOKEN }`——客户端即可用平台模型（经网关）。
 *
 * 通道：认证的共享 `/api` Fetch 路由（`connection.fetch.register`）。只依赖最小 ctx 面。
 */

import { userFromToken, type LoginRequest, type TokenPair } from '../session.ts'
import { createImBindingsFetch, IM_BINDINGS_ROUTE } from './bindings.ts'
import { createTokenRefresher } from './token.ts'

/** 平台令牌的凭据 ref（模型网关 `apiKeyEnv` 引用同一名）。 */
export const PLATFORM_TOKEN_REF = 'FOM_PLATFORM_TOKEN'

/** 刷新令牌的凭据 ref（14 天有效；续期器用）。 */
export const PLATFORM_REFRESH_REF = 'FOM_PLATFORM_REFRESH'

/** 平台网关 provider 的 settings 路由名（`llm-pi-ai.providers.<id>`）。 */
export const DEFAULT_PROVIDER_ID = 'fom-platform'

/** 平台 API 默认基址（本机 dev；正式由部署/下发配置）。 */
export const DEFAULT_PLATFORM_URL = 'http://localhost:5028'

/** 登录路由路径（认证的 `/api` 通道）。 */
export const SESSION_ROUTE = '/api/office/login/session'

interface CredentialsLike {
  set(ref: string, value: string): Promise<void> | void
}

interface SettingsLike {
  update(ns: string, patch: object): Promise<void>
}

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

interface HostContext {
  credentials?: CredentialsLike
  inject(names: readonly string[], callback: (child: HostContext) => void): void
  effect(callback: (() => (() => void) | void), label?: string): void
  get(name: string): unknown
}

/** 插件名。 */
export const name = 'office-login'

/** 需要凭据 + 设置服务。 */
export const inject = ['credentials', 'settings']

/** 配置：平台地址 + 平台模型网关 provider（K2）+ provider 路由名。 */
export interface OfficeLoginConfig {
  /** 平台 API 基址（默认本机 dev `http://localhost:5028`）。 */
  platformUrl?: string
  /** `llm-pi-ai.providers.<id>` 的路由名（默认 `fom-platform`）。 */
  providerId?: string
  /**
   * 要写入的 **完整** `llm-pi-ai` provider profile（`api`/`baseURL`/`apiKeyEnv`/`models[]`…）。
   * 由部署或平台配置下发填充（平台目录就绪前手填）；未设则**只做 K1**。
   */
  provider?: Record<string, unknown>
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** 登录代理的依赖。 */
export interface LoginFetchDeps {
  /** 平台 API 基址（已去尾斜杠）。 */
  readonly platformUrl: string
  readonly providerId: string
  /** 未设则只做 K1（不写 provider）。 */
  readonly provider?: Record<string, unknown>
  readonly credentials: CredentialsLike
  /** 未设则跳过 K2。 */
  readonly settings?: SettingsLike
  /** 可注入 fetch（单测）。 */
  readonly fetchImpl?: typeof fetch
}

/**
 * 造登录路由的处理函数（与接线拆开，便于单测）。
 * `POST { method, email, password }` → 服务端调平台 `/api/auth/login` → 令牌写凭据 + 写 provider → 回 `{ ok, user }`。
 * @param deps - 平台地址 / provider / 凭据 / 设置 / fetch。
 * @returns Fetch 处理函数。
 */
export function createLoginFetch(deps: LoginFetchDeps): (request: Request) => Promise<Response> {
  const doFetch = deps.fetchImpl ?? fetch
  return async (request) => {
    let login: LoginRequest
    try {
      login = (await request.json()) as LoginRequest
    } catch {
      return json({ ok: false, message: '请求体不是 JSON' }, 400)
    }
    // 服务端调平台（浏览器不直连 ⇒ 不受 CORS 限制）。
    let res: Response
    try {
      res = await doFetch(`${deps.platformUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(login),
      })
    } catch (error) {
      return json({ ok: false, message: `连不上平台（${deps.platformUrl}）：${String((error as Error)?.message ?? error)}` }, 200)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return json({ ok: false, status: res.status, message: text }, 200)
    }
    const pair = (await res.json()) as TokenPair
    if (typeof pair.accessToken !== 'string' || pair.accessToken === '') {
      return json({ ok: false, message: '平台未返回 accessToken' }, 200)
    }
    await deps.credentials.set(PLATFORM_TOKEN_REF, pair.accessToken)
    // 刷新令牌也要存：访问令牌 15 分钟就过期，续期器靠它换新（2026-10-19 补）。
    if (typeof pair.refreshToken === 'string' && pair.refreshToken !== '') {
      await deps.credentials.set(PLATFORM_REFRESH_REF, pair.refreshToken)
    }
    const user = userFromToken(pair.accessToken)

    // K2：把平台网关 provider 写进 llm-pi-ai settings（仅当配了 provider；best-effort，不阻断 K1）。
    let providerWritten = false
    let providerError: string | null = null
    if (deps.provider !== undefined) {
      if (deps.settings === undefined) {
        providerError = 'settings-unavailable'
      } else {
        try {
          await deps.settings.update('llm-pi-ai', { providers: { [deps.providerId]: deps.provider } })
          providerWritten = true
        } catch (e) {
          providerError = String((e as Error)?.message ?? e)
        }
      }
    }
    return json({ ok: true, user, provider: providerWritten ? deps.providerId : null, providerError }, 200)
  }
}

/**
 * 挂登录路由：宿主在服务端调平台、写凭据（令牌不过浏览器）；若配了 `provider`，同时写 `llm-pi-ai` provider。
 * @param ctx - 插件上下文（最小面）。
 * @param config - `platformUrl` / `providerId` / `provider`。
 */
export function apply(ctx: HostContext, config: OfficeLoginConfig = {}): void {
  const providerId = config.providerId ?? DEFAULT_PROVIDER_ID
  const platformUrl = (config.platformUrl ?? DEFAULT_PLATFORM_URL).replace(/\/+$/u, '')

  // **令牌自动续期**（2026-10-19）：访问令牌只有 15 分钟，而所有出站（通道 / 上报 / 任务 / 审批 /
  // 模型网关 apiKeyEnv）都读凭据里的同一个值 ⇒ 不续期就会每 15 分钟静默失效（表现为「必须重登」）。
  // 每 30s 看一眼，剩余 <2 分钟才真去换（省请求）。
  ctx.effect(() => {
    const creds = ctx.credentials ?? (ctx.get('credentials') as CredentialsLike | undefined)
    if (creds === undefined) return () => {}
    const refresher = createTokenRefresher({
      platformUrl,
      credentials: creds,
      accessRef: PLATFORM_TOKEN_REF,
      refreshRef: PLATFORM_REFRESH_REF,
      report: (message) => process.stderr.write(`[office-login] ${new Date().toISOString()} ${message}\n`),
    })
    const stop = refresher.start(30_000)
    return () => {
      stop()
    }
  }, 'office-login: 平台令牌自动续期（15 分钟有效期）')
  ctx.inject(['connection'], (connCtx) => {
    connCtx.effect(() => {
      const conn = connCtx.get('connection') as ConnectionLike | undefined
      if (conn === undefined) return () => {}
      const dispose = conn.fetch.register({
        path: SESSION_ROUTE,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => {
          const creds = connCtx.credentials ?? (connCtx.get('credentials') as CredentialsLike | undefined)
          if (creds === undefined) return Promise.resolve(json({ ok: false, message: '凭据服务不可用（credentials）' }, 500))
          return createLoginFetch({
            platformUrl,
            providerId,
            credentials: creds,
            ...(config.provider === undefined ? {} : { provider: config.provider }),
            ...((connCtx.get('settings') as SettingsLike | undefined) === undefined ? {} : { settings: connCtx.get('settings') as SettingsLike }),
          })(request)
        },
      })
      const disposeBindings = conn.fetch.register({
        path: IM_BINDINGS_ROUTE,
        methods: ['GET', 'POST', 'DELETE'],
        requestBody: 'buffered',
        fetch: (request) => {
          const creds = connCtx.credentials ?? (connCtx.get('credentials') as CredentialsLike | undefined)
          if (creds === undefined) return Promise.resolve(json({ ok: false, message: '凭据服务不可用（credentials）' }, 500))
          return createImBindingsFetch({ platformUrl, credentials: creds })(request)
        },
      })
      return () => {
        void dispose()
        void disposeBindings()
      }
    }, 'office-login: 登录（宿主代理平台）+ 令牌 + 平台 provider 写路由 + IM 绑定代理')
  })
}

export default { name, inject, apply }
