/**
 * `office-authz` 插件壳：把授权矩阵以只读服务（`officeAuthz`）挂到 context。
 * 控制台的 Remote 方法首行调 `ctx.get('officeAuthz').assertCan(role, action)`（K-P0）。
 *
 * 无 `inject`、无 `Config`（矩阵是设计决定的常量，不是部署可调项）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { assertCan, can, requiresApproval, type OfficeAction, type OfficeRole } from './roles.ts'

export * from './roles.ts'
export * from './actions.ts'

/** 授权服务面。 */
export interface OfficeAuthz {
  /** 角色能否做该动作（fail-closed）。 */
  can(role: OfficeRole, action: OfficeAction): boolean
  /** 该动作是否须审批（未登记按高危）。 */
  requiresApproval(action: OfficeAction): boolean
  /** 不允许则抛 `OfficeAuthzError`。 */
  assertCan(role: OfficeRole, action: OfficeAction): void
}

export const name = 'office-authz'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 控制台授权矩阵（只读）。由本插件提供。 */
    officeAuthz: OfficeAuthz
  }
}

/** 造授权服务（纯封装，便于单测与复用）。 */
export function createAuthzService(): OfficeAuthz {
  return { can, requiresApproval, assertCan }
}

/**
 * 把授权服务暴露为 context 服务。
 * @param ctx - 插件上下文。
 */
export function apply(ctx: Context): void {
  const service = createAuthzService()
  ctx.effect(() => ctx.reflect.provide('officeAuthz', service))
}

export default { name, apply }
