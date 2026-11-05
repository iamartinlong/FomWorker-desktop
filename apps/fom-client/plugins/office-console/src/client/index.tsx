import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { ConsolePage } from './ConsolePage.tsx'

/** 必需服务：UI 槽位注册表。 */
export const inject = ['slots']

/** 侧栏图标：三类资源（技能/专家/连接器）—— 16×16 / 线宽 1.2 / 圆角（对齐 WorkBuddy）。 */
function ConsoleIcon() {
  const s = { stroke: 'currentColor', strokeWidth: 1.2, fill: 'none' } as const
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden="true">
      <rect x={1.6} y={1.6} width={5.2} height={5.2} rx={1.6} {...s} />
      <rect x={9.2} y={1.6} width={5.2} height={5.2} rx={1.6} {...s} />
      <rect x={1.6} y={9.2} width={5.2} height={5.2} rx={1.6} {...s} />
      <circle cx={11.8} cy={11.8} r={2.6} {...s} />
    </svg>
  )
}

/**
 * 挂 office-console 控制台：`main` 面板（key `office-console`）+ `sidebar.panellist` 入口。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'office-console' }, ConsolePage))
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register({ name: 'sidebar.panellist', id: 'office-console', order: 98, label: () => '专家·技能·连接器' }, ConsoleIcon),
  )
}
