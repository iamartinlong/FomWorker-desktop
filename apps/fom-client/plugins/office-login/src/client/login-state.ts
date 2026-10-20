/**
 * 登录的**可观察状态源**（两个槽位共享）：模式 + 当前身份。
 *
 * 为什么不用 `window.location.reload()` 切态：门禁（`shell.overlay`）与账号行
 * （`sidebar.footer.action`）是**两个独立槽位**，需要看同一份状态 ⇒ 用槽位
 * `inject` 里的 `hooks` 约定（裸 `getSnapshot`/`subscribe` 源），渲染器把它绑成
 * `useMode(selector)` 交给组件（见 `docs/subsystems/slots.md` §Developer-provided injection）。
 */
import { createLocalStore, createSession, type PersistedSession, type UserInfo } from '../../session.ts'
import {
  clearLocalMode,
  createLocalModeStore,
  enterLocalMode,
  resolveMode,
  type AppMode,
  type ModeStore,
} from './mode.ts'

/** 宿主模式标记路由（浏览器把模式写给宿主，供 office-channel 等读取）。 */
export const MODE_ROUTE = '/api/office/login/mode'

/** 宿主登出路由（清宿主凭据库里的令牌）。 */
export const LOGOUT_ROUTE = '/api/office/login/session'

/**
 * 通知宿主清令牌（best-effort：失败也照常回门禁，只是宿主侧的令牌可能还在）。
 *
 * 为什么必须有它：退出登录如果只清浏览器身份，**宿主凭据库里的令牌仍然有效** ⇒
 * 通道/上报/模型网关继续用旧令牌连平台，等于「退出没退」。
 */
export function publishLogout(): void {
  try {
    void fetch(LOGOUT_ROUTE, { method: 'DELETE' }).catch(() => {
      /* 宿主不可达：本地状态仍然生效 */
    })
  } catch {
    /* fetch 不可用（测试环境）：忽略 */
  }
}

/**
 * 把模式写给宿主（best-effort：失败不影响本地状态）。
 *
 * 为什么需要它：本地模式标记在 `localStorage`，**宿主插件看不见**；而 `office-channel`
 * 要在启动时判断「用户明确选了不连平台」才能降频、不刷日志（2026-10-19 实测）。
 * @param mode 模式
 */
export function publishMode(mode: AppMode): void {
  try {
    void fetch(MODE_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode }),
    }).catch(() => {
      /* 宿主不可达：本地状态仍然生效，只是宿主侧降频晚一步 */
    })
  } catch {
    /* fetch 不可用（测试环境）：忽略 */
  }
}

/** 登录状态的快照（身份 + 模式一次取齐，避免两次快照不一致）。 */
export interface LoginSnapshot {
  readonly mode: AppMode
  readonly user: UserInfo | null
}

/** 裸可观察源（渲染器只认 `getSnapshot` / `subscribe`）。 */
export interface LoginSource {
  getSnapshot(): LoginSnapshot
  subscribe(listener: () => void): () => void
}

/** 登录状态控制器：源 + 变更动作（动作只由 `apply` 闭包持有）。 */
export interface LoginState {
  readonly source: LoginSource
  /** 登录成功（身份已落盘 ⇒ 清本地标记）。 */
  signedIn(user: UserInfo): void
  /** 选「先本地使用」。 */
  useLocal(): void
  /** 退出登录（回门禁）。 */
  signOut(): void
  /** 从本地模式回到登录门禁。 */
  requireSignIn(): void
}

/**
 * 造登录状态。
 * @param sessionStore 身份存储（`session.ts`）
 * @param modeStore 模式存储
 * @returns 源与动作
 */
export function createLoginState(
  sessionStore = createLocalStore(),
  modeStore: ModeStore = createLocalModeStore(),
): LoginState {
  const read = (): LoginSnapshot => {
    const session: PersistedSession | null = sessionStore.load()
    return { mode: resolveMode(sessionStore, modeStore), user: session?.user ?? null }
  }

  let snapshot = read()
  const listeners = new Set<() => void>()

  /** 重读并通知（只在值真的变了时换引用，避免多余重渲染）。 */
  const refresh = (): void => {
    const next = read()
    if (next.mode === snapshot.mode && next.user === snapshot.user) return
    snapshot = next
    for (const listener of listeners) listener()
  }

  return {
    source: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    signedIn: () => {
      clearLocalMode(modeStore)
      refresh()
      publishMode('signed')
    },
    useLocal: () => {
      enterLocalMode(modeStore)
      refresh()
      publishMode('local')
    },
    signOut: () => {
      createSession({ store: sessionStore }).logout()
      clearLocalMode(modeStore)
      refresh()
      publishLogout()
      publishMode('gate')
    },
    requireSignIn: () => {
      clearLocalMode(modeStore)
      refresh()
      publishMode('gate')
    },
  }
}
