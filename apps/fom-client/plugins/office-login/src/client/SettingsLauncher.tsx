/**
 * 左下角唯一入口（`settings.launcher`）。
 *
 * ## 形状与官方一致
 *
 * 官方 `ui-settings-account` 的规则是：未登录显示「更多」，登录后在同一位置显示账号。
 * 我们照同一形状做，但「账号」指的是**平台身份**（`FOM_PLATFORM_TOKEN`），不是 DeepSeek
 * 官方账号——本产品不支持官方账号体系。
 *
 * 三态：
 * - `signed`：头像 + 显示名，点击打开设置面板（账号页在里面）；
 * - `local`：与未登录相同的外观（「更多」），点击同样打开设置面板——**登录入口在面板里**，
 *   这样左下角永远只有一行，不会出现「本地模式 + 更多」两条并列；
 * - `gate`：门禁已盖住全屏，仍渲染「更多」（门禁是 portal，不影响底栏）。
 *
 * 为什么不做成 `sidebar.footer.action` 的独立行：那个槽位渲染在 `settingsArea` **之上**，
 * 于是「账号行 + 更多」会变成两个并列入口，视觉上像是两个同级的设置入口——2026-10-21
 * 用户明确否掉了那个形状。
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UserInfo } from '../../session.ts'
import { avatarInitialOf, displayNameOf, type AppMode } from './mode.ts'
import css from './SettingsLauncher.module.css'

export interface SettingsLauncherProps {
  readonly mode: AppMode
  readonly user: UserInfo | null
  /** 侧栏是否宽态（折叠时只显示图标）。 */
  readonly wide: boolean
  /** 设置面板是否已打开（用作 aria 状态）。 */
  readonly settingsOpen: boolean
  /** 打开设置面板。 */
  readonly openSettings: () => void
}

/**
 * 左下角入口。
 * @param props.mode - 当前登录态
 * @param props.user - 身份（`signed` 时有值）
 * @param props.wide - 侧栏宽态
 * @param props.settingsOpen - 面板已打开
 * @param props.openSettings - 打开面板
 * @returns 「更多」或账号行
 */
export function SettingsLauncher({ mode, user, wide, settingsOpen, openSettings }: SettingsLauncherProps) {
  if (mode === 'signed' && user !== null) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className={css.launcher}
        aria-expanded={settingsOpen}
        title={`${displayNameOf(user)} · 账号设置`}
        onClick={openSettings}
      >
        <span className={css.avatar} aria-hidden="true">{avatarInitialOf(user)}</span>
        {wide ? <span className={css.label}>{displayNameOf(user)}</span> : null}
      </Button>
    )
  }

  // 未登录 / 本地模式：与官方「更多」同形。登录入口在设置面板的账号页里。
  return (
    <Button
      variant="ghost"
      size="sm"
      className={css.launcher}
      aria-expanded={settingsOpen}
      title="更多（设置 / 账号）"
      onClick={openSettings}
    >
      <span className={css.dots} aria-hidden="true">⋯</span>
      {wide ? <span className={css.label}>更多</span> : null}
    </Button>
  )
}
