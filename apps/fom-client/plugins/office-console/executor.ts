/**
 * 控制台**真实执行体**（M2/D）：把写端点从「回显桩」换成**有状态**的实现。
 *
 * - `capability.toggle`：翻转 `CapabilityStore` 里的启用位（真实状态改变，可由 `state-route` 读回）。
 * - `bundle.install`/`bundle.remove`：**委托**给注入的 `InstallerPort`（内核 `pluginManager` 的适配口）；
 *   未注入则**不真装**，返回 `{ dryRun: true }`（安全默认——装插件＝root 等价，须显式接线 + 审批）。
 * - `config.edit`/`skill.create`：登记接受（真实写入留后续）。
 *
 * 依据：`docs/02-设计/控制台写操作权限设计v0.1.md`、`M2控制面前端扩展方案v0.1.md`（对象级安装缺口）。
 */

import type { OfficeAction } from '../office-authz/roles.ts'
import { isValidSkillSlug } from '../office-skills/managed.ts'
import { isValidExpertId } from '../office-experts/delta.ts'
import type { ApprovalStore } from './approvals.ts'
import type { ConsoleActionExecutor } from './console-actions.ts'
import { exportExpert, exportSkill, parsePortableExpert, parsePortableSkill } from './portable.ts'

/** 一个能力的启用态。 */
export interface CapabilityState {
  readonly id: string
  enabled: boolean
}

/**
 * **输入类**错误（调用方载荷不对：缺字段 / 非法值 / 目标不存在）。
 * 写路由据此映射 **400**（而非 500）——见 `console-actions.ts`。
 * 判别**看 `code`，不看 `instanceof`**（对齐内核跨副本教义）。
 */
export class OfficeInputError extends Error {
  readonly code = 'invalid-input'
  constructor(message: string) {
    super(message)
    this.name = 'OfficeInputError'
  }
}

/** 能力启用态存储（进程内；跨重启持久化留后续）。 */
export interface CapabilityStore {
  list(): CapabilityState[]
  get(id: string): CapabilityState | undefined
  setEnabled(id: string, enabled: boolean): CapabilityState | undefined
}

/**
 * 用种子造能力存储（可选**持久化回调**：每次 `setEnabled` 后整份回写，供跨重启）。
 * @param seed - 初始条目（通常来自 `officeCatalog` 的 `{id, defaultEnabled}`，叠加已持久化的启用位）。
 * @param persist - 状态变更回调（缺省不持久化）。
 * @returns 存储。
 */
export function createCapabilityStore(
  seed: readonly { id: string; enabled: boolean }[],
  persist?: (states: readonly CapabilityState[]) => void,
): CapabilityStore {
  const map = new Map<string, CapabilityState>(seed.map((entry) => [entry.id, { id: entry.id, enabled: entry.enabled }]))
  const notify = (): void => { persist?.([...map.values()].map((state) => ({ ...state }))) }
  return {
    list: () => [...map.values()].map((state) => ({ ...state })),
    get: (id) => { const state = map.get(id); return state === undefined ? undefined : { ...state } },
    setEnabled: (id, enabled) => {
      const state = map.get(id)
      if (state === undefined) return undefined
      state.enabled = enabled
      notify()
      return { ...state }
    },
  }
}

/** 安装口（内核 `pluginManager` 的适配面；装插件＝root 等价，须显式注入 + 走审批）。 */
export interface InstallerPort {
  install(spec: string): Promise<unknown>
  remove(spec: string): Promise<unknown>
}

/** 技能口（受管技能根的写/删/读；C3 + C4e 导出）。 */
export interface SkillPort {
  /** 写一个受管技能，返回 SKILL.md 路径。 */
  create(spec: { slug: string; name: string; description: string; body: string }): string
  /** 删一个受管技能。 */
  remove(slug: string): boolean
  /** 读一个受管技能（导出用）；不存在 → `undefined`。 */
  read(slug: string): { slug: string; name: string; description: string; body: string } | undefined
}

/** 专家 delta 的写入口最小面（C4c）。 */
export interface ExpertSpec {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly persona: { prefix?: string; suffix?: string }
  readonly tools: { enable?: string[]; disable?: string[] }
  readonly skills?: string[]
}

/** 专家口（受管专家 delta 的写/删/读；写含**立即注册**；C4c + C4e 导出）。 */
export interface ExpertPort {
  create(spec: ExpertSpec): Promise<string>
  remove(id: string): boolean
  /** 读一个专家 delta（导出用）；不存在 → `undefined`。 */
  read(id: string): ExpertSpec | undefined
}

/** 执行体依赖。 */
export interface ExecutorDeps {
  readonly store: CapabilityStore
  /** 未注入则 install/remove 走 dry-run（不真装）。 */
  readonly installer?: InstallerPort
  /** 未注入则 skill.create/remove 走 dry-run（不真写）。 */
  readonly skills?: SkillPort
  /** 未注入则 expert.create/remove 走 dry-run（不真写）。 */
  readonly experts?: ExpertPort
  /** 审批存储（`approval.decide` 用；未注入则 `approval.decide` 不可用）。 */
  readonly approvals?: ApprovalStore
}

function record(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
}

/**
 * 造真实执行体。
 * @param deps - 存储与可选安装口。
 * @returns `ConsoleActionExecutor`。
 */
export function createConsoleExecutor(deps: ExecutorDeps): ConsoleActionExecutor {
  return async (action: OfficeAction, payload: unknown): Promise<unknown> => {
    const p = record(payload)
    switch (action) {
      case 'capability.toggle': {
        const id = p.id
        const on = p.on
        if (typeof id !== 'string' || typeof on !== 'boolean') throw new OfficeInputError('capability.toggle 需要 { id, on }')
        const next = deps.store.setEnabled(id, on)
        if (next === undefined) throw new OfficeInputError(`未知能力：${id}`)
        return { capability: next }
      }
      case 'bundle.install':
      case 'bundle.remove': {
        const spec = p.spec
        if (typeof spec !== 'string' || spec === '') throw new OfficeInputError(`${action} 需要 { spec }`)
        if (deps.installer === undefined) return { dryRun: true, action, spec }
        const result = action === 'bundle.install' ? await deps.installer.install(spec) : await deps.installer.remove(spec)
        return { result }
      }
      case 'connector.install':
      case 'connector.remove': {
        // 连接器＝一类可装/卸的资源：装/卸走 installer（MCP 配置型 bundle / 自研渠道），并翻转启用位。
        const id = p.id
        const ref = p.ref
        if (typeof id !== 'string' || id === '') throw new OfficeInputError(`${action} 需要 { id }`)
        if (typeof ref !== 'string' || ref === '') throw new OfficeInputError(`${action} 需要 { ref }`)
        const install = action === 'connector.install'
        if (deps.installer === undefined) return { dryRun: true, action, id, ref }
        const result = install ? await deps.installer.install(ref) : await deps.installer.remove(ref)
        const capability = deps.store.setEnabled(id, install)
        return { connector: capability ?? { id, enabled: install }, result }
      }
      case 'config.edit':
        return { accepted: true, action, payload: p }
      case 'skill.create': {
        const slug = p.slug
        const name = p.name
        const body = p.body
        if (typeof slug !== 'string' || slug === '') throw new OfficeInputError('skill.create 需要 { slug }')
        if (typeof name !== 'string' || name === '') throw new OfficeInputError('skill.create 需要 { name }')
        if (typeof body !== 'string' || body === '') throw new OfficeInputError('skill.create 需要 { body }')
        // slug 作目录名：非法在**输入边界**拒（否则深层 `writeManagedSkill` 抛普通 Error ⇒ 500）。
        if (!isValidSkillSlug(slug)) throw new OfficeInputError(`非法技能 slug：${slug}`)
        if (deps.skills === undefined) return { dryRun: true, action, slug }
        const path = deps.skills.create({ slug, name, description: typeof p.description === 'string' ? p.description : '', body })
        return { skill: { slug, path } }
      }
      case 'skill.remove': {
        const slug = p.slug
        if (typeof slug !== 'string' || slug === '') throw new OfficeInputError('skill.remove 需要 { slug }')
        if (deps.skills === undefined) return { dryRun: true, action, slug }
        return { skill: { slug, removed: deps.skills.remove(slug) } }
      }
      case 'skill.export': {
        const slug = p.slug
        if (typeof slug !== 'string' || slug === '') throw new OfficeInputError('skill.export 需要 { slug }')
        if (deps.skills === undefined) return { dryRun: true, action, slug }
        const spec = deps.skills.read(slug)
        if (spec === undefined) throw new OfficeInputError(`技能不存在：${slug}`)
        return { bundle: exportSkill(spec) }
      }
      case 'skill.import': {
        const { skill, problems } = parsePortableSkill(p.bundle)
        if (skill === undefined) throw new OfficeInputError(`技能包非法：${problems.join('；')}`)
        if (deps.skills === undefined) return { dryRun: true, action, slug: skill.slug }
        const path = deps.skills.create(skill)
        return { skill: { slug: skill.slug, path } }
      }
      case 'expert.create': {
        const id = p.id
        const name = p.name
        if (typeof id !== 'string' || id === '') throw new OfficeInputError('expert.create 需要 { id }')
        if (typeof name !== 'string' || name === '') throw new OfficeInputError('expert.create 需要 { name }')
        // id 作 preset id 与文件名：非法在**输入边界**拒。
        if (!isValidExpertId(id)) throw new OfficeInputError(`非法专家 id：${id}`)
        if (deps.experts === undefined) return { dryRun: true, action, id }
        const record = (key: string): Record<string, unknown> =>
          typeof p[key] === 'object' && p[key] !== null ? (p[key] as Record<string, unknown>) : {}
        const path = await deps.experts.create({
          id,
          name,
          description: typeof p.description === 'string' ? p.description : '',
          persona: record('persona') as { prefix?: string; suffix?: string },
          tools: record('tools') as { enable?: string[]; disable?: string[] },
          ...(Array.isArray(p.skills) ? { skills: p.skills.filter((s): s is string => typeof s === 'string') } : {}),
        })
        return { expert: { id, path } }
      }
      case 'expert.remove': {
        const id = p.id
        if (typeof id !== 'string' || id === '') throw new OfficeInputError('expert.remove 需要 { id }')
        if (deps.experts === undefined) return { dryRun: true, action, id }
        return { expert: { id, removed: deps.experts.remove(id) } }
      }
      case 'expert.export': {
        const id = p.id
        if (typeof id !== 'string' || id === '') throw new OfficeInputError('expert.export 需要 { id }')
        if (deps.experts === undefined) return { dryRun: true, action, id }
        const spec = deps.experts.read(id)
        if (spec === undefined) throw new OfficeInputError(`专家不存在：${id}`)
        return { bundle: exportExpert(spec) }
      }
      case 'expert.import': {
        const { expert, problems } = parsePortableExpert(p.bundle)
        if (expert === undefined) throw new OfficeInputError(`专家包非法：${problems.join('；')}`)
        if (deps.experts === undefined) return { dryRun: true, action, id: expert.id }
        const path = await deps.experts.create(expert)
        return { expert: { id: expert.id, path } }
      }
      case 'approval.decide': {
        const id = p.id
        const decision = p.decision
        if (typeof id !== 'string' || (decision !== 'grant' && decision !== 'reject')) {
          throw new OfficeInputError('approval.decide 需要 { id, decision: grant|reject }')
        }
        if (deps.approvals === undefined) throw new Error('approval.decide 不可用：未注入审批存储')
        const record = decision === 'grant' ? deps.approvals.grant(id) : deps.approvals.reject(id)
        if (record === undefined) throw new OfficeInputError(`审批不可裁决（不存在或非 pending）：${id}`)
        return { approval: record }
      }
      default:
        throw new OfficeInputError(`未处理的动作：${String(action)}`)
    }
  }
}
