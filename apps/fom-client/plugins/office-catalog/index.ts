/**
 * `office-catalog` 插件壳：把 L0 默认能力目录以只读服务的形式挂到 context（`officeCatalog`）。
 *
 * 下游（L1 用户自管理界面 / L2 运营后台）用 `inject:['officeCatalog']` 消费它。P0 不挂 UI、
 * 不做安装动作；`apply` 只做一件事——把 `createCatalogService()` 暴露出去，并在卸载时撤掉。
 *
 * 无 `inject`（不依赖任何内核服务）、无 `Config`（没有当前消费方的可调项，不预置空配置）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { createCatalogService, type OfficeCatalog } from './catalog.ts'

export * from './catalog.ts'

export const name = 'office-catalog'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 平台默认能力目录（只读）。由本插件提供，声明即注入面。 */
    officeCatalog: OfficeCatalog
  }
}

/**
 * 把默认能力目录暴露为 context 服务。
 * @param ctx - 插件上下文。
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.reflect.provide('officeCatalog', createCatalogService()))
}

export default { name, apply }
