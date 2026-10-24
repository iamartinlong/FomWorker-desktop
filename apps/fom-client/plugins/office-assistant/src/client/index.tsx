import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { AssistantPage } from './AssistantPage.tsx'

/** 必需服务：UI 槽位注册表。 */
export const inject = ['slots']

/** 侧栏图标：智能助理（星芒 + 会话气泡）。 */
function AssistantIcon() {
  const s = { stroke: 'currentColor', strokeWidth: 1.2, fill: 'none' } as const
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.6 L9.2 5.4 L13 6.6 L9.2 7.8 L8 11.6 L6.8 7.8 L3 6.6 L6.8 5.4 Z" {...s} />
      <path d="M3.2 11.2 C3.8 12.6 4.9 13.2 6.2 13.2 L11.2 13.2 C12.4 13.2 13.2 12.4 13.2 11.2" {...s} />
    </svg>
  )
}

/**
 * 挂「智能助理」面板：`main` 面板（key `office-assistant`）+ `sidebar.panellist` 入口。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'office-assistant' }, AssistantPage))
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      { name: 'sidebar.panellist', id: 'office-assistant', order: 50, label: () => '智能助理' },
      AssistantIcon,
    ),
  )
}
