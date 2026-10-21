/**
 * `office-login` 的浏览器半：**登录门禁**（`shell.overlay`）+ **底栏账号行**（`sidebar.footer.action`）。
 *
 * 为什么是门禁而不是内容页（设计稿 §0）：登录是**进入应用的前置**，不是应用里的一个页面 ⇒
 * 用 root 级 `shell.overlay` 盖住整个框架；同时允许**先本地使用**（本地能力完整），标记
 * 持久化到 `fomworker.mode`。
 *
 * 两个槽位看**同一份状态**：经注册 `inject` 的 `hooks` 约定暴露裸可观察源，渲染器绑成
 * `useLogin(selector)` 交给组件（`docs/subsystems/slots.md` §Developer-provided injection）。
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { shouldGate } from './mode.ts'
import { createLoginState, type LoginSnapshot } from './login-state.ts'
import { LoginPage } from './LoginPage.tsx'
import { AccountRow } from './AccountRow.tsx'
import { AccountOverlay } from './AccountOverlay.tsx'

/** 必需服务：UI 槽位注册表。 */
export const inject = ['slots']

/** 两个槽位共用的选择器类型（由注册 `inject.hooks` 绑定）。 */
type UseLogin = <T>(selector: (snapshot: LoginSnapshot) => T) => T

interface GateProps {
  useLogin: UseLogin
  onSignedIn(): void
  onLocalMode(): void
}

/**
 * 门禁组件（`shell.overlay`）：只在 `gate` 态渲染。
 *
 * **为什么要 portal 到 `document.body`**：`shell.overlay` 渲染在 `.frame`（`display:grid` +
 * `overflow:hidden`）内部，是网格子项且受 frame 层叠上下文约束 ⇒ 仅靠 `position:fixed`
 * 仍会让侧栏压在门禁之上（2026-10-19 实测截图）。挂到 body 后不受任何祖先布局影响。
 *
 * @param props.useLogin - 状态选择器
 * @param props.onSignedIn - 登录成功
 * @param props.onLocalMode - 选「先本地使用」
 * @returns 全屏登录页（portal），或 null
 */
export function LoginGate({ useLogin, onSignedIn, onLocalMode }: GateProps) {
  const mode = useLogin((snapshot) => snapshot.mode)
  if (!shouldGate(mode)) return null
  return createPortal(
    <LoginPage onSignedIn={onSignedIn} onLocalMode={onLocalMode} />,
    document.body,
  )
}

interface AccountSlotProps {
  useLogin: UseLogin
  wide?: boolean
  onSignIn(): void
  onSignOut(): void
  onOpenAccount(): void
}

/**
 * 底栏账号行（`sidebar.footer.action`）。
 * @param props.useLogin - 状态选择器
 * @param props.wide - 侧栏宽态
 * @param props.onSignIn - 本地模式回登录
 * @param props.onSignOut - 退出登录
 * @param props.onOpenAccount - 打开账号 overlay
 * @returns 账号行
 */
export function AccountSlot({ useLogin, wide, onSignIn, onSignOut, onOpenAccount }: AccountSlotProps) {
  const mode = useLogin((snapshot) => snapshot.mode)
  const user = useLogin((snapshot) => snapshot.user)
  return (
    <AccountRow
      mode={mode}
      user={user}
      {...(wide === undefined ? {} : { wide })}
      onSignIn={onSignIn}
      onSignOut={onSignOut}
      onOpenAccount={onOpenAccount}
    />
  )
}

interface AccountHostProps {
  useLogin: UseLogin
  onSignOut(): void
}

/**
 * 账号 overlay 宿主（`shell.overlay`）：开合是**本组件局部状态**（不属于跨槽位共享事实）。
 * @param props.useLogin - 状态选择器
 * @param props.onSignOut - 退出登录
 * @returns 打开时渲染账号面板，否则 null
 */
export function AccountHost({ useLogin, onSignOut }: AccountHostProps) {
  // 开合由账号行通过公开事件驱动：用自定义事件避免跨槽位共享可变状态。
  const [open, setOpen] = useState(false)
  const mode = useLogin((snapshot) => snapshot.mode)
  const user = useLogin((snapshot) => snapshot.user)

  useAccountOpenEvent(setOpen)

  if (!open || mode !== 'signed' || user === null) return null
  return (
    <AccountOverlay
      user={user}
      onClose={() => setOpen(false)}
      onSignOut={() => {
        setOpen(false)
        onSignOut()
      }}
    />
  )
}

/**
 * 账号 overlay 的开合事件名（账号行 → overlay 宿主）。
 */
export const ACCOUNT_OPEN_EVENT = 'fomworker:account-open'

/**
 * 订阅「打开账号」事件（挂载时注册、卸载时摘除）。
 * @param setOpen 开合设置器
 */
function useAccountOpenEvent(setOpen: (open: boolean) => void): void {
  useEffect(() => {
    const onOpen = (): void => setOpen(true)
    window.addEventListener(ACCOUNT_OPEN_EVENT, onOpen)
    return () => window.removeEventListener(ACCOUNT_OPEN_EVENT, onOpen)
  }, [setOpen])
}

/**
 * 挂门禁、账号行与账号 overlay。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  const login = createLoginState()

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'office-login-gate',
        inject: () => ({
          hooks: { login: login.source },
          onSignedIn: () => {
            // 身份已由 `session.login` 落盘 ⇒ 这里只清本地标记并重读快照。
            login.signedIn()
          },
          onLocalMode: () => {
            login.useLocal()
          },
        }),
      },
      LoginGate,
    ),
  )

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'office-login-account',
        inject: () => ({
          hooks: { login: login.source },
          onSignOut: () => {
            login.signOut()
          },
        }),
      },
      AccountHost,
    ),
  )

  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'office-login-account-row',
        inject: () => ({
          hooks: { login: login.source },
          onSignIn: () => {
            login.requireSignIn()
          },
          onSignOut: () => {
            login.signOut()
          },
          onOpenAccount: () => {
            window.dispatchEvent(new CustomEvent(ACCOUNT_OPEN_EVENT))
          },
        }),
      },
      AccountSlot,
    ),
  )
}
