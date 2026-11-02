/**
 * 设置面板里的**账号页**（`settings.section`，id `fomworker-account`）。
 *
 * ## 为什么要放进设置面板
 *
 * 官方把账号放在设置面板的统一入口背后（左下角 `settings.launcher`），本产品支持的是
 * **平台账号**而不是官方账号，但入口形状应当一致：用户在一个地方找到所有「关于我」的东西。
 *
 * 早期实现把账号做成侧栏底部的独立一行，与「更多」并列 ⇒ 左下角出现两个同级入口
 * （2026-10-21 用户明确否掉）。现在登录入口在这里，左下角只留一个入口。
 *
 * 三态：
 * - `signed`：身份信息 + IM 绑定 + 退出登录；
 * - `local` / `gate`：说明为什么还没登录 + 「登录」按钮（点了回门禁）。
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UserInfo } from '../../session.ts'
import { avatarInitialOf, displayNameOf, type AppMode } from './mode.ts'
import { ImBindings } from './ImBindings.tsx'
import css from './AccountSection.module.css'

export interface AccountSectionProps {
  readonly mode: AppMode
  readonly user: UserInfo | null
  /** 未登录时回登录门禁。 */
  readonly onSignIn: () => void
  /** 退出登录。 */
  readonly onSignOut: () => void
}

/**
 * 账号页内容。
 * @param props.mode - 当前登录态
 * @param props.user - 身份（`signed` 时有值）
 * @param props.onSignIn - 回登录门禁
 * @param props.onSignOut - 退出登录
 * @returns 账号分区
 */
export function AccountSection({ mode, user, onSignIn, onSignOut }: AccountSectionProps) {
  if (mode !== 'signed' || user === null) {
    return (
      <div className={css.page}>
        <header className={css.head}>
          <span className={`${css.avatar} ${css.avatarLocal}`} aria-hidden="true">L</span>
          <div className={css.identity}>
            <span className={css.name}>本地模式</span>
            <span className={css.meta}>未登录 · 平台能力（模型、任务、IM）需要登录后使用</span>
          </div>
        </header>
        <div className={css.actions}>
          <Button variant="primary" size="sm" onClick={onSignIn}>登录</Button>
        </div>
      </div>
    )
  }

  return (
    <div className={css.page}>
      <header className={css.head}>
        <span className={css.avatar} aria-hidden="true">{avatarInitialOf(user)}</span>
        <div className={css.identity}>
          <span className={css.name}>{displayNameOf(user)}</span>
          <span className={css.meta}>
            {[user.email, user.role, user.tenantId].filter((part) => part !== undefined && part !== '').join(' · ')}
          </span>
        </div>
      </header>

      <section className={css.section}>
        <ImBindings active />
      </section>

      <div className={css.actions}>
        <Button variant="outline" size="sm" onClick={onSignOut}>退出登录</Button>
      </div>
    </div>
  )
}
