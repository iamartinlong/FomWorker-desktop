/**
 * 路由与身份的**纯逻辑核心**（M2/C · R0）：把「IM 身份 → 租户 + 角色 → 会话章」从设计稿落成可执行、可测的形状。
 *
 * 依据：`docs/02-设计/路由与权限模型设计v0.1.md` §3/§4。
 * 内核**没有** tenant/role/user 字段（F5/F9）⇒ 我们自维护 `open_id → (tenant,role)` 与 `tenantId → 记录`，
 * 在**会话创建窗口**把 `(tenant,role,workspaceRoot,preset,身份提示)` 盖成一个「会话章」（F10①）。
 *
 * 纯模块，无 cordis、无 IO；真正的表（bindings/tenants）由控制面从自己的 storage 提供，会话创建布线由适配器做。
 * **fail-closed**：身份未绑定、或绑定的租户记录缺失 → 返回 `undefined`（上层拒）。
 */

/** 角色（对齐 `路由与权限模型设计` §3 四角色）。 */
export type TenantRole = 'owner' | 'admin' | 'member' | 'guest'

/** 全部角色。 */
export const TENANT_ROLES: readonly TenantRole[] = Object.freeze(['owner', 'admin', 'member', 'guest'])

/** 一个 IM 身份绑定。 */
export interface MemberBinding {
  readonly tenantId: string
  readonly role: TenantRole
}

/** 一个租户记录（数据面落点）。 */
export interface TenantRecord {
  readonly tenantId: string
  readonly homeDir: string
  readonly workspaceRoot: string
}

/** 路由表（控制面提供）。 */
export interface RouterTables {
  /** IM `open_id`→绑定。 */
  readonly bindings: Readonly<Record<string, MemberBinding>>
  /** `tenantId`→租户记录。 */
  readonly tenants: Readonly<Record<string, TenantRecord>>
}

/** 会话章：创建会话时按它布线（预设 / 工作区 / 身份提示）。 */
export interface SessionStamp {
  readonly tenantId: string
  readonly role: TenantRole
  readonly homeDir: string
  readonly workspaceRoot: string
  readonly presetId: string
  readonly identityNotice: string
}

/** 角色 → 预设 id（`路由与权限模型设计` §3：owner/admin=全量、member=办公、guest=只读）。 */
export const ROLE_PRESET: Readonly<Record<TenantRole, string>> = Object.freeze({
  owner: 'standard',
  admin: 'standard',
  member: 'office',
  guest: 'readonly',
})

/**
 * 造身份提示段文案（进 `systemPrompt.section`）。**只含租户与角色名，不含任何凭据**。
 * @param tenantId - 租户 id。
 * @param role - 角色。
 * @returns 提示文案。
 */
export function identityNoticeFor(tenantId: string, role: TenantRole): string {
  return `你在租户「${tenantId}」中，角色为「${role}」。请按该角色的能力边界行动，不要越权或跨租户操作。`
}

/**
 * 解析一个入站身份到一个**会话章**；任一环缺失即返回 `undefined`（fail-closed）。
 * @param openId - 入站 `open_id`/`user_id`。
 * @param tables - 路由表。
 * @returns 会话章；未绑定或租户缺失则 `undefined`。
 */
export function resolveContext(openId: string, tables: RouterTables): SessionStamp | undefined {
  const binding = tables.bindings[openId]
  if (binding === undefined) return undefined
  const tenant = tables.tenants[binding.tenantId]
  if (tenant === undefined) return undefined
  return {
    tenantId: tenant.tenantId,
    role: binding.role,
    homeDir: tenant.homeDir,
    workspaceRoot: tenant.workspaceRoot,
    presetId: ROLE_PRESET[binding.role],
    identityNotice: identityNoticeFor(tenant.tenantId, binding.role),
  }
}

/**
 * 校验路由表自洽（供装配期/测试）：每个绑定指向已存在的租户、角色合法、租户记录字段非空。
 * @param tables - 路由表。
 * @returns 问题清单；空＝通过。
 */
export function validateTables(tables: RouterTables): string[] {
  const problems: string[] = []
  for (const [openId, binding] of Object.entries(tables.bindings)) {
    if (!TENANT_ROLES.includes(binding.role)) problems.push(`绑定 ${openId} 角色非法：${binding.role}`)
    if (tables.tenants[binding.tenantId] === undefined) problems.push(`绑定 ${openId} 指向不存在的租户：${binding.tenantId}`)
  }
  for (const [tenantId, tenant] of Object.entries(tables.tenants)) {
    if (tenant.tenantId !== tenantId) problems.push(`租户记录键与 id 不符：${tenantId} vs ${tenant.tenantId}`)
    if (tenant.homeDir === '') problems.push(`租户 ${tenantId} homeDir 为空`)
    if (tenant.workspaceRoot === '') problems.push(`租户 ${tenantId} workspaceRoot 为空`)
  }
  return problems
}
