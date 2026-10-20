/**
 * 账号 overlay（`shell.overlay`）：身份 + IM 绑定 + 退出登录。
 *
 * 为什么自建而不是复用内核设置面板（设计稿 §3.3 已核实）：`openSettings` 只作为 owner props
 * 传给 `settings.launcher` 槽位的组件，**不是可注入的服务**；且该槽位是 `single`、已被内核
 * `ui-settings-account` 占用 ⇒ 我们无法接管，只能自建。
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UserInfo } from '../../session.ts'
import { avatarInitialOf, displayNameOf } from './mode.ts'
import { ImBindings } from './ImBindings.tsx'
import css from './AccountOverlay.module.css'

export interface AccountOverlayProps {
  readonly user: UserInfo
  readonly onClose: () => void
  readonly onSignOut: () => void
}

/**
 * 账号面板。
 * @param props.user - 当前身份
 * @param props.onClose - 关闭
 * @param props.onSignOut - 退出登录
 * @returns 居中卡片 + 遮罩
 */
export function AccountOverlay({ user, onClose, onSignOut }: AccountOverlayProps) {
  return (
    <div
      className={css.mask}
      role="dialog"
      aria-modal="true"
      aria-label="账号"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className={css.panel}>
        <header className={css.head}>
          <span className={css.avatar} aria-hidden="true">{avatarInitialOf(user)}</span>
          <div className={css.identity}>
            <span className={css.name}>{displayNameOf(user)}</span>
            <span className={css.meta}>
              {[user.email, user.role, user.tenantId].filter((part) => part !== undefined && part !== '').join(' · ')}
            </span>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>关闭</Button>
        </header>

        <section className={css.section}>
          <ImBindings active />
        </section>

        <footer className={css.foot}>
          <Button variant="outline" size="sm" onClick={onSignOut}>退出登录</Button>
        </footer>
      </div>
    </div>
  )
}
