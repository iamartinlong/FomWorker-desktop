/**
 * `office-billing` 的浏览器半：**设置页「用量与配额」**（`settings.section`）。
 *
 * 为什么搬到这里（设计稿 §0 第 5 条）：配额原先渲染在「专家·技能·连接器」页顶部，
 * 而那页讲能力目录——打开「装技能」先看到「Token 334/1000 已超限」，两件事无关。
 * 设置里放「账号 / 用量配额」符合通行做法，也让能力目录页回归纯净。
 *
 * 数据来自宿主 `GET /api/office/quota`（令牌不过浏览器）；「同步」打 `POST /api/office/quota/sync`。
 * 口径照 G6：**权威在网关**，本地只展示，不阻断。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { UsageSection } from './UsageSection.tsx'

/** 必需服务：UI 槽位注册表。 */
export const inject = ['slots']

/**
 * 挂设置页「用量与配额」。
 *
 * `settings.section` 是 `list`，必须带 `id`；`order` 排在账号（-10）之后。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: 'usage', order: 10, label: () => '用量与配额' },
      UsageSection,
    ),
  )
}
