/**
 * 底栏账号行（`sidebar.footer.action`，设置之上）。
 *
 * 三态显示（设计稿 §3.4）：
 * - `signed`：头像 + 显示名 + 角色；点开账号 overlay；
 * - `local`：虚线头像 + 「本地模式」+ 「未登录」；点击回登录门禁；
 * - `gate`：不渲染（门禁已盖住全屏）。
 *
 * 折叠侧栏（`wide === false`）只显示头像。
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UserInfo } from '../../session.ts'
import { avatarInitialOf, displayNameOf, type AppMode } from './mode.ts'
import css from './AccountRow.module.css'

export interface AccountRowProps {
  readonly mode: AppMode
  readonly user: UserInfo | null
  /** 侧栏是否宽态（决定要不要显示文字）。 */
  readonly wide?: boolean
  /** 已登录：打开账号 overlay。 */
  readonly onOpenAccount?: () => void
  /** 本地模式：回登录门禁。 */
  readonly onSignIn?: () => void
  /** 退出登录。 */
  readonly onSignOut?: () => void
}

/**
 * 账号行。
 * @param props.mode - 当前态
 * @param props.user - 身份（`signed` 时有值）
 * @param props.wide - 侧栏宽态（缺省 true）
 * @returns 一行账号信息
 */
export function AccountRow({ mode, user, wide = true, onOpenAccount, onSignIn, onSignOut }: AccountRowProps) {
  if (mode === 'gate') return null

  if (mode === 'local' || user === null) {
    return (
      <button type="button" className={css.row} onClick={onSignIn} title="本地模式 · 点此登录">
        <span className={`${css.avatar} ${css.avatarLocal}`} aria-hidden="true">L</span>
        {wide ? (
          <span className={css.text}>
            <span className={css.name}>本地模式</span>
            <span className={css.sub}>未登录 · 点此登录</span>
          </span>
        ) : null}
      </button>
    )
  }

  return (
    <div className={css.row}>
      <button type="button" className={css.identity} onClick={onOpenAccount} title="账号与 IM 绑定">
        <span className={css.avatar} aria-hidden="true">{avatarInitialOf(user)}</span>
        {wide ? (
          <span className={css.text}>
            <span className={css.name}>{displayNameOf(user)}</span>
            <span className={css.sub}>{user.role ?? '成员'}</span>
          </span>
        ) : null}
      </button>
      {wide ? (
        <Button variant="ghost" size="sm" onClick={onSignOut} title="退出登录">
          退出
        </Button>
      ) : null}
    </div>
  )
}
