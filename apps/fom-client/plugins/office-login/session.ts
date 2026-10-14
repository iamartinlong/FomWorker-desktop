/**
 * `office-login` —— 登录会话（纯逻辑，可测）。
 *
 * 对接契约 `packages/fom-contracts/openapi/platform.yaml` 的 `/auth/login`（`LoginRequest` → `TokenPair` + `user`）。
 * 令牌入**本地存储**（浏览器 localStorage / 内存；正式应走宿主 `ctx.credentials` + Remote，见 TODO）。
 * 无 cordis、无 IO（`fetch` 可注入），单测直接调。
 */

/** 令牌对（对齐契约 `TokenPair`）。 */
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

/** 持久化的会话。 */
export interface PersistedSession {
  readonly tokens: TokenPair
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
  /** 登录：调平台 `/auth/login`，成功则存会话并返回用户。 */
  login(request: LoginRequest): Promise<UserInfo>
  /** 登出：清会话。 */
  logout(): void
  /** 当前会话（未登录为 null）。 */
  current(): PersistedSession | null
  /** 当前访问令牌（未登录为 null）。 */
  token(): string | null
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
 * `sub` / `tenant_id` / `email` / `role`）。解不出返回 null。
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

/**
 * 造登录会话。
 * @param deps - 平台地址 + 存储 + 可注入 fetch。
 * @returns `OfficeSession`。
 */
export function createSession(deps: { platformUrl: string; store: SessionStore; fetchImpl?: typeof fetch }): OfficeSession {
  const doFetch = deps.fetchImpl ?? fetch
  const base = deps.platformUrl.replace(/\/+$/, '')
  return {
    async login(request) {
      const res = await doFetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
      if (!res.ok) throw new Error(`登录失败：HTTP ${res.status}`)
      const payload = (await res.json()) as TokenPair & { user?: UserInfo }
      // 平台只回 TokenPair；身份优先取显式 user，否则从 JWT 解。
      const user: UserInfo = payload.user ?? userFromToken(payload.accessToken) ?? { userId: '', tenantId: '' }
      const session: PersistedSession = {
        tokens: { accessToken: payload.accessToken, refreshToken: payload.refreshToken, ...(payload.tokenType === undefined ? {} : { tokenType: payload.tokenType }), ...(payload.expiresIn === undefined ? {} : { expiresIn: payload.expiresIn }) },
        user,
      }
      deps.store.save(session)
      return user
    },
    logout() {
      deps.store.clear()
    },
    current() {
      return deps.store.load()
    },
    token() {
      return deps.store.load()?.tokens.accessToken ?? null
    },
  }
}
