/**
 * `office-login` —— 登录会话（纯逻辑，可测）。
 *
 * ⚠️ **登录经宿主代理**：平台**不开 CORS**（见 `交接文档` §7「连不上这件事已经解决」），
 * 浏览器直连平台会被挡 ⇒ 浏览器只调**宿主的认证路由** `POST /api/office/login/session`
 * （宿主半 `src/index.ts` 在服务端调平台 `/api/auth/login`）。
 * **令牌不过浏览器**：宿主拿到后直接写 `ctx.credentials`（ref `FOM_PLATFORM_TOKEN`），只把 `user` 回给前端。
 *
 * 契约：`packages/fom-contracts/openapi/platform.yaml` 的 `/auth/login`（`LoginRequest` → `TokenPair`）。
 * 无 cordis、无 IO（`fetch` 可注入），单测直接调。
 */

/** 令牌对（对齐契约 `TokenPair`；仅宿主半使用）。 */
export interface TokenPair {
  readonly accessToken: string
  readonly refreshToken: string
  readonly tokenType?: string
  readonly expiresIn?: number
}

/** 当前用户（对齐契约 `UserInfo`）。 */
export interface UserInfo {
  readonly userId: string
  readonly tenantId: string
  readonly email?: string
  readonly displayName?: string
  readonly role?: string
}

/** 登录请求（对齐契约 `LoginRequest`）。 */
export interface LoginRequest {
  readonly method: 'oidc' | 'email'
  readonly email?: string
  readonly password?: string
  readonly idToken?: string
}

/** 宿主的登录路由（浏览器 → 宿主；宿主再打平台）。 */
export const SESSION_URL = '/api/office/login/session'

/** 持久化的会话（浏览器侧**只存身份**，不存令牌）。 */
export interface PersistedSession {
  readonly user: UserInfo
}

/** 会话存储。 */
export interface SessionStore {
  load(): PersistedSession | null
  save(session: PersistedSession): void
  clear(): void
}

/** 内存存储（单测 / 无 localStorage 环境）。 */
export function createMemoryStore(): SessionStore {
  let current: PersistedSession | null = null
  return {
    load: () => current,
    save: (session) => {
      current = session
    },
    clear: () => {
      current = null
    },
  }
}

/** localStorage 存储（浏览器）；无 `localStorage` 时退化为内存。 */
export function createLocalStore(key = 'fomworker.session'): SessionStore {
  const ls = (globalThis as { localStorage?: Storage }).localStorage
  if (ls === undefined) return createMemoryStore()
  return {
    load: () => {
      try {
        const raw = ls.getItem(key)
        return raw === null ? null : (JSON.parse(raw) as PersistedSession)
      } catch {
        return null
      }
    },
    save: (session) => {
      try {
        ls.setItem(key, JSON.stringify(session))
      } catch {
        /* 配额/隐私模式：忽略 */
      }
    },
    clear: () => {
      try {
        ls.removeItem(key)
      } catch {
        /* 忽略 */
      }
    },
  }
}

/** 登录会话。 */
export interface OfficeSession {
  /** 登录：调**宿主**登录路由，成功则存身份并返回用户。 */
  login(request: LoginRequest): Promise<UserInfo>
  /** 登出：清会话。 */
  logout(): void
  /** 当前会话（未登录为 null）。 */
  current(): PersistedSession | null
}

/** base64url 段 → UTF-8 字符串（浏览器/Node 均可用 `atob` + `TextDecoder`）。 */
function b64urlToText(segment: string): string {
  const b64 = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/** 解 JWT 载荷（不验签；仅取展示用身份）。 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    return JSON.parse(b64urlToText(parts[1] as string)) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * 从访问令牌解出用户（平台 `/auth/login` 只回 `TokenPair`，身份在 JWT 里：
 * `sub` / `tenant_id` / `email` / `role`）。解不出返回 null。**宿主半**用它把 `user` 回给前端。
 * @param accessToken - 访问令牌（JWT）。
 * @returns `UserInfo` 或 null。
 */
export function userFromToken(accessToken: string): UserInfo | null {
  const payload = decodeJwtPayload(accessToken)
  if (payload === null) return null
  const userId = typeof payload.sub === 'string' ? payload.sub : ''
  const tenantId = typeof payload.tenant_id === 'string' ? payload.tenant_id : ''
  if (userId === '' && tenantId === '') return null
  return {
    userId,
    tenantId,
    ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
    ...(typeof payload.role === 'string' ? { role: payload.role } : {}),
  }
}

/** 宿主登录路由的应答（`ok=false` 时带平台状态与消息）。 */
export interface SessionResponse {
  readonly ok: boolean
  readonly user?: UserInfo
  readonly status?: number
  readonly message?: string
}

/**
 * 造登录会话（浏览器侧）。
 * @param deps - 宿主登录路由 + 存储 + 可注入 fetch。
 * @returns `OfficeSession`。
 */
export function createSession(deps: { sessionUrl?: string; store: SessionStore; fetchImpl?: typeof fetch }): OfficeSession {
  const doFetch = deps.fetchImpl ?? fetch
  const url = deps.sessionUrl ?? SESSION_URL
  return {
    async login(request) {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
      if (!res.ok) throw new Error(`登录失败：HTTP ${res.status}`)
      const payload = (await res.json()) as SessionResponse
      if (payload.ok !== true || payload.user === undefined) {
        throw new Error(payload.message !== undefined && payload.message !== '' ? payload.message : `登录失败：HTTP ${payload.status ?? '?'}`)
      }
      deps.store.save({ user: payload.user })
      return payload.user
    },
    logout() {
      deps.store.clear()
    },
    current() {
      return deps.store.load()
    },
  }
}
