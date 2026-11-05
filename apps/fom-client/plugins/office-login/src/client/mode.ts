/**
 * 登录 / 本地模式的**状态机与持久化**（纯逻辑，可单测）。
 *
 * 三态（设计稿 §3.1）：
 * - `gate`：未登录且未选本地 ⇒ 全屏登录门禁；
 * - `local`：用户明确选「先本地使用」⇒ 进应用，但平台能力全部不可用；
 * - `signed`：已登录 ⇒ 全功能。
 *
 * 持久化两条独立的键（**身份**与**模式**分开，避免互相覆盖）：
 * - `fomworker.session`：`{ user }`（已有，`session.ts` 在用；**只存身份不存令牌**）；
 * - `fomworker.mode`：`'local'`（本地模式标记）。
 *
 * 判定顺序（`resolveMode`）：有身份 ⇒ `signed`（身份优先）> 有本地标记 ⇒ `local` > `gate`。
 */
import type { PersistedSession, SessionStore, UserInfo } from '../../session.ts'

/** 三态。 */
export type AppMode = 'gate' | 'local' | 'signed'

/** 本地模式标记的存储键。 */
export const MODE_KEY = 'fomworker.mode'

/** 本地模式标记的值。 */
export const LOCAL_MODE_VALUE = 'local'

/** 键值存储的最小面（浏览器用 `localStorage`，单测用内存）。 */
export interface ModeStore {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

/** 内存实现（单测 / 无 localStorage 环境）。 */
export function createMemoryModeStore(): ModeStore {
  const rows = new Map<string, string>()
  return {
    get: (key) => rows.get(key) ?? null,
    set: (key, value) => {
      rows.set(key, value)
    },
    remove: (key) => {
      rows.delete(key)
    },
  }
}

/** localStorage 实现；无 `localStorage` 时退化为内存（隐私模式 / SSR）。 */
export function createLocalModeStore(): ModeStore {
  const ls = (globalThis as { localStorage?: Storage }).localStorage
  if (ls === undefined) return createMemoryModeStore()
  return {
    get: (key) => {
      try {
        return ls.getItem(key)
      } catch {
        return null
      }
    },
    set: (key, value) => {
      try {
        ls.setItem(key, value)
      } catch {
        /* 配额 / 隐私模式：忽略 */
      }
    },
    remove: (key) => {
      try {
        ls.removeItem(key)
      } catch {
        /* 忽略 */
      }
    },
  }
}

/** 读本地模式标记。 */
export function isLocalMode(store: ModeStore): boolean {
  return store.get(MODE_KEY) === LOCAL_MODE_VALUE
}

/** 记下「先本地使用」。 */
export function enterLocalMode(store: ModeStore): void {
  store.set(MODE_KEY, LOCAL_MODE_VALUE)
}

/** 清掉本地模式标记（登录成功 / 回门禁时调）。 */
export function clearLocalMode(store: ModeStore): void {
  store.remove(MODE_KEY)
}

/**
 * 判当前该进哪个态。
 *
 * **身份优先**：既有身份又有本地标记时按 `signed`（标记是登录前的选择，登录后应失效）。
 * @param sessionStore 身份存储（`session.ts` 的 `SessionStore`）
 * @param modeStore 模式存储
 * @returns 三态
 */
export function resolveMode(sessionStore: SessionStore, modeStore: ModeStore): AppMode {
  const session: PersistedSession | null = sessionStore.load()
  if (session !== null && session.user !== undefined) return 'signed'
  if (isLocalMode(modeStore)) return 'local'
  return 'gate'
}

/** 该不该挡门禁（`gate` 才挡）。 */
export function shouldGate(mode: AppMode): boolean {
  return mode === 'gate'
}

/**
 * 从身份里取显示名（账号行用；缺失时退回邮箱、再退回「已登录」）。
 * @param user 身份
 * @returns 一行显示名
 */
export function displayNameOf(user: UserInfo): string {
  const name = (user.displayName ?? '').trim()
  if (name !== '') return name
  const email = (user.email ?? '').trim()
  if (email !== '') return email
  return '已登录'
}

/** 头像用的首字（中文取首字，英文取首字母大写）。 */
export function avatarInitialOf(user: UserInfo): string {
  const name = displayNameOf(user)
  const first = [...name][0] ?? '·'
  return first.toUpperCase()
}
