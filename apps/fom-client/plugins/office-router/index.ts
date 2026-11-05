/**
 * `office-router` 插件壳（M2/C · R0）：把路由/身份**纯逻辑**以只读服务（`officeRouter`）挂到 context。
 * 入站适配器在**会话创建窗口**调它拿「会话章」，据此选预设 / 定 `meta.cwd` / 注入身份提示段（R0 布线）。
 *
 * 无 `inject`、无 `Config`（路由表由控制面提供，见 `resolve(openId, tables)`）。
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  ROLE_PRESET,
  TENANT_ROLES,
  identityNoticeFor,
  resolveContext,
  validateTables,
  type RouterTables,
  type SessionStamp,
  type TenantRole,
} from './directory.ts'

export * from './directory.ts'
export * from './wiring.ts'

/** 路由服务面。 */
export interface OfficeRouter {
  /** 解析入站身份 → 会话章（fail-closed）。 */
  resolve(openId: string, tables: RouterTables): SessionStamp | undefined
  /** 造身份提示段文案。 */
  identityNotice(tenantId: string, role: TenantRole): string
  /** 校验路由表自洽。 */
  validate(tables: RouterTables): string[]
  /** 全部角色。 */
  readonly roles: readonly TenantRole[]
  /** 角色 → 预设 id。 */
  readonly rolePreset: Readonly<Record<TenantRole, string>>
}

export const name = 'office-router'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 路由/身份（只读）。由本插件提供。 */
    officeRouter: OfficeRouter
  }
}

/**
 * 把路由服务暴露为 context 服务。
 * @param ctx - 插件上下文。
 */
export function apply(ctx: Context): void {
  const service: OfficeRouter = {
    resolve: resolveContext,
    identityNotice: identityNoticeFor,
    validate: validateTables,
    roles: TENANT_ROLES,
    rolePreset: ROLE_PRESET,
  }
  ctx.effect(() => ctx.reflect.provide('officeRouter', service))
}

export default { name, apply }
