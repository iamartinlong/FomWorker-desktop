/**
 * `office-login` 的浏览器半：**登录门禁**（`shell.overlay`）+ **左下角账号入口**（`settings.launcher`）
 * + **设置里的账号页**（`settings.section`）。
 *
 * 为什么是门禁而不是内容页（设计稿 §0）：登录是**进入应用的前置**，不是应用里的一个页面 ⇒
 * 用 root 级 `shell.overlay` 盖住整个框架；同时允许**先本地使用**（本地能力完整），标记
 * 持久化到 `fomworker.mode`。
 *
 * ## 左下角只有一个入口（2026-10-21 修正）
 *
 * 早期设计让账号占一条独立的 `sidebar.footer.action` 行，理由是「`settings.launcher` 是
 * single、被内核占用 ⇒ 无法接管」。**那个结论是错的**：`ui-slots` 的 cell 用 `priority`
 * 决定谁显示（ascending，最低的渲染），同 priority 二次注册才抛错。所以我们可以用
 * `priority: -1` 接管官方 `ui-settings-account` 的 launcher。
 *
 * 官方本来就是「同一位置，登录后显示账号」（`ui-settings-account` 只在 `credential-stored`
 * 时注册 `settings.section`）。我们照同一形状做，但接入的是**平台账号**而不是官方账号。
 *
 * 三个槽位看**同一份状态**：经注册 `inject` 的 `hooks` 约定暴露裸可观察源，渲染器绑成
 * `useLogin(selector)` 交给组件（`docs/subsystems/slots.md` §Developer-provided injection）。
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { shouldGate } from './mode.ts'
import { createLoginState, type LoginSnapshot } from './login-state.ts'
import { LoginPage } from './LoginPage.tsx'
import { AccountSection } from './AccountSection.tsx'
import { SettingsLauncher } from './SettingsLauncher.tsx'

/** 必需服务：UI 槽位注册表。 */
export const inject = ['slots']

/** 三个槽位共用的选择器类型（由注册 `inject.hooks` 绑定）。 */
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

interface SectionProps {
  useLogin: UseLogin
  onSignIn(): void
  onSignOut(): void
}

/**
 * 设置里的账号页（`settings.section`）。
 * @param props.useLogin - 状态选择器
 * @param props.onSignIn - 未登录时回登录门禁
 * @param props.onSignOut - 退出登录
 * @returns 账号分区内容
 */
export function AccountSlot({ useLogin, onSignIn, onSignOut }: SectionProps) {
  const mode = useLogin((snapshot) => snapshot.mode)
  const user = useLogin((snapshot) => snapshot.user)
  return <AccountSection mode={mode} user={user} onSignIn={onSignIn} onSignOut={onSignOut} />
}

interface LauncherProps {
  useLogin: UseLogin
  wide: boolean
  settingsOpen: boolean
  openSettings(): void
}

/**
 * 左下角入口（`settings.launcher`）：未登录显示「更多」，登录后显示账号。
 * @param props.useLogin - 状态选择器
 * @param props.wide - 侧栏宽态
 * @param props.settingsOpen - 设置面板是否已打开
 * @param props.openSettings - 打开设置面板
 * @returns 一行入口
 */
export function LauncherSlot({ useLogin, wide, settingsOpen, openSettings }: LauncherProps) {
  const mode = useLogin((snapshot) => snapshot.mode)
  const user = useLogin((snapshot) => snapshot.user)
  return (
    <SettingsLauncher
      mode={mode}
      user={user}
      wide={wide}
      settingsOpen={settingsOpen}
      openSettings={openSettings}
    />
  )
}

/**
 * 挂门禁、左下角入口与设置里的账号页。
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

  // 左下角只有一个入口：接管官方 `ui-settings-account` 的 launcher。
  //
  // `priority: -1` 低于官方默认的 0 ⇒ 同一 cell 里我们渲染（见 ui-slots 的 shadowing 规则）。
  // 不这样做的话，官方那个「更多」会继续显示，而它打开的是官方账号页。
  ctx.slots.inject('settings.launcher', () =>
    ctx.slots.register(
      {
        name: 'settings.launcher',
        priority: -1,
        inject: () => ({
          hooks: { login: login.source },
        }),
      },
      LauncherSlot,
    ),
  )

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'fomworker-account',
        // 排在官方账号分区（-10）之后：我们不与它争「账号」这个 id，
        // 而是明确作为 FomWorker 自己的账号页出现。
        order: 5,
        label: () => '账号',
        inject: () => ({
          hooks: { login: login.source },
          onSignIn: () => {
            login.requireSignIn()
          },
          onSignOut: () => {
            login.signOut()
          },
        }),
      },
      AccountSlot,
    ),
  )
}
