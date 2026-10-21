import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { FomHeroMark, FomMark, FomName } from './Brand.ts'

/** 必需服务：UI 槽位注册表。 */
export const inject = ['slots']

/**
 * 占 FomWorker 品牌槽位（侧栏 logo/名称 + 聊天页 hero）。
 * 用声明感知的 ctx.slots.inject，顺序无关、随 fiber 回滚、HMR 安全。
 * 不照抄官方 ui-brand-official 的 official-profile 门控——本包无条件注册。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark' }, FomMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name' }, FomName)
    }))
  ctx.slots.inject('conversation.hero.brand.mark', () =>
    ctx.slots.register({ name: 'conversation.hero.brand.mark' }, FomHeroMark))
}
