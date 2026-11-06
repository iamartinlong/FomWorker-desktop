import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { FomHeroMark, FomMark, FomName } from './Brand.ts'

/** 必需服务：UI 槽位注册表。 */
export const inject = ['slots']

/**
 * 压过官方品牌注册的优先级。
 *
 * 官方 `ui-brand-official` 也在 `sidebar.brand.mark` / `.name`（**single** 槽位）注册，且它
 * 所在的 `dsh-web-app` 层**先于**我们的 bundle 层。`ui-slots` 对**同 priority** 的第二次注册
 * 直接抛 `single slot "…" already has a registration` ⇒ 我们的插件被标成失败、槽位保留官方
 * 内容 ⇒ 界面一直是 `deepseek HARNESS`（2026-10-21 实测）。
 *
 * cell 的显示规则是 **priority ascending，最低的渲染**，所以 -1 是 shadow 而不是冲突。
 */
const SHADOW_OFFICIAL = -1

/**
 * 占 FomWorker 品牌槽位（侧栏 logo/名称 + 聊天页 hero）。
 * 用声明感知的 ctx.slots.inject，顺序无关、随 fiber 回滚、HMR 安全。
 * 不照抄官方 ui-brand-official 的 official-profile 门控——本包无条件注册。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark', priority: SHADOW_OFFICIAL }, FomMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name', priority: SHADOW_OFFICIAL }, FomName)
    }))
  // 聊天页 hero：官方不注册这个槽位（官方注释明说「the official build registers nothing
  // there」），所以这里不需要压优先级；仍带上同一个值以保持一致，无副作用。
  ctx.slots.inject('conversation.hero.brand.mark', () =>
    ctx.slots.register({ name: 'conversation.hero.brand.mark', priority: SHADOW_OFFICIAL }, FomHeroMark))
}
