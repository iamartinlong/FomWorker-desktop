/**
 * 控制台**授权矩阵**（K-P0）：把「角色 × 动作」从设计稿落成可执行、可测的纯逻辑。
 *
 * 依据：`docs/02-设计/控制台写操作权限设计v0.1.md` §2 的授权矩阵；角色来自
 * `路由与权限模型设计v0.1.md`（owner/admin/member/guest）。
 *
 * 为什么是「矩阵 + 函数」而不是 RBAC 引擎：内核 Remote **只认证不授权**（`Remote数据通道设计` R6），
 * 授权只能**写在方法内**；角色本身也只是「预设 + 工具掩码 + 技能 + (sandbox,审批)」的一次求值
 * （`路由与权限模型设计` D1）。这里只回答「这个角色能不能做这个动作、要不要审批」。
 *
 * 纯模块，无 cordis 依赖；插件壳在 `index.ts`。
 */

/** 控制台动作（写操作取最小集，可扩展）。 */
export type OfficeAction =
  | 'console.view'
  | 'capability.toggle'
  | 'bundle.install'
  | 'bundle.remove'
  | 'config.edit'
  | 'skill.create'
  | 'approval.decide'

/** 角色（对齐 `路由与权限模型设计` §3 的四角色）。 */
export type OfficeRole = 'owner' | 'admin' | 'member' | 'guest'

/** 一个动作的策略。 */
export interface ActionPolicy {
  /** 允许该动作的角色集合。 */
  readonly allow: readonly OfficeRole[]
  /** 是否是**高危动作**（须走审批，见 `控制台写操作权限设计` §2）。 */
  readonly requiresApproval: boolean
}

/**
 * 动作 → 策略。**未列出的动作一律拒绝**（fail-closed）。
 * 依据 `控制台写操作权限设计v0.1.md` §2 的授权矩阵。
 */
export const ACTION_POLICY: Readonly<Record<OfficeAction, ActionPolicy>> = Object.freeze({
  'console.view': { allow: ['owner', 'admin', 'member'], requiresApproval: false },
  'capability.toggle': { allow: ['owner', 'admin'], requiresApproval: false },
  'bundle.install': { allow: ['owner', 'admin'], requiresApproval: true },
  'bundle.remove': { allow: ['owner', 'admin'], requiresApproval: true },
  'config.edit': { allow: ['owner', 'admin'], requiresApproval: true },
  'skill.create': { allow: ['owner', 'admin', 'member'], requiresApproval: false },
  'approval.decide': { allow: ['owner', 'admin'], requiresApproval: false },
})

/** 全部已知动作（校验/遍历用，顺序稳定）。 */
export const OFFICE_ACTIONS: readonly OfficeAction[] = Object.freeze([
  'console.view',
  'capability.toggle',
  'bundle.install',
  'bundle.remove',
  'config.edit',
  'skill.create',
  'approval.decide',
])

/** 全部角色。 */
export const OFFICE_ROLES: readonly OfficeRole[] = Object.freeze(['owner', 'admin', 'member', 'guest'])

/** 授权失败（判别看 `code`，不看 `instanceof`；对齐内核跨副本教义）。 */
export class OfficeAuthzError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'OfficeAuthzError'
    this.code = code
  }
}

/**
 * 角色能否做该动作。未登记的动作返回 `false`（fail-closed）。
 * @param role - 角色。
 * @param action - 动作。
 * @returns 允许为 `true`。
 */
export function can(role: OfficeRole, action: OfficeAction): boolean {
  const policy: ActionPolicy | undefined = ACTION_POLICY[action]
  return policy !== undefined && policy.allow.includes(role)
}

/**
 * 该动作是否高危（须审批）。未登记动作按**高危**处理（fail-closed）。
 * @param action - 动作。
 * @returns 须审批为 `true`。
 */
export function requiresApproval(action: OfficeAction): boolean {
  const policy: ActionPolicy | undefined = ACTION_POLICY[action]
  return policy === undefined ? true : policy.requiresApproval
}

/**
 * 断言角色可做该动作；不可则抛 `OfficeAuthzError`（`code='office-authz/forbidden'`）。
 * @param role - 角色。
 * @param action - 动作。
 * @throws {OfficeAuthzError} 不允许时。
 */
export function assertCan(role: OfficeRole, action: OfficeAction): void {
  if (!can(role, action)) {
    throw new OfficeAuthzError('office-authz/forbidden', `角色 ${role} 不允许动作 ${action}`)
  }
}

/**
 * 校验矩阵自身完整性（供装配期/测试用）：每个动作的 allow 非空、角色合法、且**没有 guest 的高危动作**。
 * @returns 问题清单；空＝通过。
 */
export function validatePolicy(): string[] {
  const problems: string[] = []
  for (const action of OFFICE_ACTIONS) {
    const policy = ACTION_POLICY[action]
    if (policy === undefined) {
      problems.push(`动作缺策略：${action}`)
      continue
    }
    if (policy.allow.length === 0) problems.push(`动作无允许角色：${action}`)
    for (const role of policy.allow) {
      if (!OFFICE_ROLES.includes(role)) problems.push(`动作 ${action} 含未知角色 ${role}`)
    }
    if (policy.requiresApproval && policy.allow.includes('guest')) {
      problems.push(`高危动作不允许 guest：${action}`)
    }
  }
  for (const action of Object.keys(ACTION_POLICY) as OfficeAction[]) {
    if (!OFFICE_ACTIONS.includes(action)) problems.push(`策略含未登记动作：${action}`)
  }
  return problems
}
