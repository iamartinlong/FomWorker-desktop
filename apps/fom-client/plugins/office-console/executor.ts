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
import type { ApprovalStore } from './approvals.ts'
import type { ConsoleActionExecutor } from './console-actions.ts'

/** 一个能力的启用态。 */
export interface CapabilityState {
  readonly id: string
  enabled: boolean
}

/** 能力启用态存储（进程内；跨重启持久化留后续）。 */
export interface CapabilityStore {
  list(): CapabilityState[]
  get(id: string): CapabilityState | undefined
  setEnabled(id: string, enabled: boolean): CapabilityState | undefined
}

/**
 * 用种子造进程内能力存储。
 * @param seed - 初始条目（通常来自 `officeCatalog` 的 `{id, defaultEnabled}`）。
 * @returns 存储。
 */
export function createCapabilityStore(seed: readonly { id: string; enabled: boolean }[]): CapabilityStore {
  const map = new Map<string, CapabilityState>(seed.map((entry) => [entry.id, { id: entry.id, enabled: entry.enabled }]))
  return {
    list: () => [...map.values()].map((state) => ({ ...state })),
    get: (id) => { const state = map.get(id); return state === undefined ? undefined : { ...state } },
    setEnabled: (id, enabled) => {
      const state = map.get(id)
      if (state === undefined) return undefined
      state.enabled = enabled
      return { ...state }
    },
  }
}

/** 安装口（内核 `pluginManager` 的适配面；装插件＝root 等价，须显式注入 + 走审批）。 */
export interface InstallerPort {
  install(spec: string): Promise<unknown>
  remove(spec: string): Promise<unknown>
}

/** 执行体依赖。 */
export interface ExecutorDeps {
  readonly store: CapabilityStore
  /** 未注入则 install/remove 走 dry-run（不真装）。 */
  readonly installer?: InstallerPort
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
        if (typeof id !== 'string' || typeof on !== 'boolean') throw new Error('capability.toggle 需要 { id, on }')
        const next = deps.store.setEnabled(id, on)
        if (next === undefined) throw new Error(`未知能力：${id}`)
        return { capability: next }
      }
      case 'bundle.install':
      case 'bundle.remove': {
        const spec = p.spec
        if (typeof spec !== 'string' || spec === '') throw new Error(`${action} 需要 { spec }`)
        if (deps.installer === undefined) return { dryRun: true, action, spec }
        const result = action === 'bundle.install' ? await deps.installer.install(spec) : await deps.installer.remove(spec)
        return { result }
      }
      case 'config.edit':
      case 'skill.create':
        return { accepted: true, action, payload: p }
      case 'approval.decide': {
        const id = p.id
        const decision = p.decision
        if (typeof id !== 'string' || (decision !== 'grant' && decision !== 'reject')) {
          throw new Error('approval.decide 需要 { id, decision: grant|reject }')
        }
        if (deps.approvals === undefined) throw new Error('approval.decide 不可用：未注入审批存储')
        const record = decision === 'grant' ? deps.approvals.grant(id) : deps.approvals.reject(id)
        if (record === undefined) throw new Error(`审批不可裁决（不存在或非 pending）：${id}`)
        return { approval: record }
      }
      default:
        throw new Error(`未处理的动作：${String(action)}`)
    }
  }
}
