/**
 * `office-login` 的 node half（K1 + K2）。
 *
 * K1：把浏览器面板拿到的令牌写入**宿主凭据库** `ctx.credentials`（ref `FOM_PLATFORM_TOKEN`）。
 * K2：令牌落库后，把**平台网关 provider** 写进 `llm-pi-ai` settings（`providers.<id>` =
 *     `{ baseURL: <网关>, apiKeyEnv: FOM_PLATFORM_TOKEN }`）——客户端即可用平台模型（经网关）。
 *
 * 通道：认证的共享 `/api` Fetch 路由（`connection.fetch.register`）。只依赖最小 ctx 面。
 */

/** 平台令牌的凭据 ref（模型网关 `apiKeyEnv` 引用同一名）。 */
export const PLATFORM_TOKEN_REF = 'FOM_PLATFORM_TOKEN'

/** 平台网关 provider 的 settings 路由名（`llm-pi-ai.providers.<id>`）。 */
export const DEFAULT_PROVIDER_ID = 'fom-platform'

/** 写路由路径（认证的 `/api` 通道）。 */
export const TOKEN_ROUTE = '/api/office/login/token'

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
  effect(callback: () => (() => void) | void, label?: string): void
  get(name: string): unknown
}

/** 插件名。 */
export const name = 'office-login'

/** 需要凭据 + 设置服务。 */
export const inject = ['credentials', 'settings']

/** 配置：平台模型网关 provider（K2）+ provider 路由名。 */
export interface OfficeLoginConfig {
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

/**
 * 挂写路由：`POST {accessToken}` → 存 `ctx.credentials`；若配了 `gatewayUrl`，同时写 `llm-pi-ai` provider。
 * @param ctx - 插件上下文（最小面）。
 * @param config - `gatewayUrl` / `providerId`。
 */
export function apply(ctx: HostContext, config: OfficeLoginConfig = {}): void {
  const providerId = config.providerId ?? DEFAULT_PROVIDER_ID
  ctx.inject(['connection'], (connCtx) => {
    connCtx.effect(() => {
      const conn = connCtx.get('connection') as ConnectionLike | undefined
      if (conn === undefined) return () => {}
      const dispose = conn.fetch.register({
        path: TOKEN_ROUTE,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          const creds = connCtx.credentials ?? (connCtx.get('credentials') as CredentialsLike | undefined)
          if (creds === undefined) return json({ code: 'credentials-unavailable' }, 500)
          let accessToken = ''
          try {
            accessToken = String((await request.json() as { accessToken?: unknown }).accessToken ?? '')
          } catch {
            return json({ code: 'bad-request' }, 400)
          }
          if (accessToken === '') return json({ code: 'missing-token' }, 400)
          await creds.set(PLATFORM_TOKEN_REF, accessToken)

          // K2：把平台网关 provider 写进 llm-pi-ai settings（仅当配了 provider；best-effort，不阻断 K1）。
          let providerWritten = false
          let providerError: string | null = null
          if (config.provider !== undefined) {
            const settings = connCtx.get('settings') as SettingsLike | undefined
            if (settings === undefined) {
              providerError = 'settings-unavailable'
            } else {
              try {
                await settings.update('llm-pi-ai', { providers: { [providerId]: config.provider } })
                providerWritten = true
              } catch (e) {
                providerError = String((e as Error)?.message ?? e)
              }
            }
          }
          return json({ ok: true, ref: PLATFORM_TOKEN_REF, provider: providerWritten ? providerId : null, providerError }, 200)
        },
      })
      return () => {
        void dispose()
      }
    }, 'office-login: 令牌 + 平台 provider 写路由')
  })
}

export default { name, inject, apply }
