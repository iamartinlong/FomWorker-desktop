import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { LoginPage } from './LoginPage.tsx'

/** 必需服务：UI 槽位注册表。 */
export const inject = ['slots']

/** 侧栏图标：登录/账号（16×16 / 线宽 1.2）。 */
function LoginIcon() {
  const s = { stroke: 'currentColor', strokeWidth: 1.2, fill: 'none' } as const
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx={8} cy={5.4} r={2.8} {...s} />
      <path d="M2.8 13.6 C3.4 10.8 5.4 9.6 8 9.6 C10.6 9.6 12.6 10.8 13.2 13.6" {...s} />
    </svg>
  )
}

/**
 * 挂登录面板：`main` 面板（key `office-login`）+ `sidebar.panellist` 入口。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'office-login' }, LoginPage))
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register({ name: 'sidebar.panellist', id: 'office-login', order: 97, label: () => '登录' }, LoginIcon),
  )
}
