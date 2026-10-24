/**
 * 控制台**服务端审批存储**（M2/D）：高危写的「pending → granted → consumed」状态机。
 *
 * 为什么要它：写端点**不信客户端批准位**（`控制台写操作权限设计` KE3），所以高危动作必须由**服务端**产生并裁决
 * 一次审批——写端点先创建一条 `pending`，审批人经认证通道 `grant`，随后**带服务端签发的审批 id** 再提交，
 * 服务端核对「已批准且动作+载荷摘要一致」后才放行（`consume` 一次性）。
 *
 * 进程内存储；跨重启持久化留后续（对应「一 home 一活实例」的控制面存储）。
 */

import { createHash, randomUUID } from 'node:crypto'
import type { OfficeAction } from '../office-authz/roles.ts'

/** 审批状态。 */
export type ApprovalStatus = 'pending' | 'granted' | 'rejected' | 'consumed'

/** 一条审批。 */
export interface ApprovalRecord {
  readonly id: string
  readonly action: OfficeAction
  /** 动作 + 载荷的稳定摘要（比对「批的是不是同一件事」）。 */
  readonly digest: string
  status: ApprovalStatus
}

/** 审批存储。 */
export interface ApprovalStore {
  /** 为一个高危动作创建（或复用同载荷的）pending 审批。 */
  request(action: OfficeAction, payload: unknown): ApprovalRecord
  get(id: string): ApprovalRecord | undefined
  list(): ApprovalRecord[]
  /** `pending → granted`。 */
  grant(id: string): ApprovalRecord | undefined
  /** `pending → rejected`。 */
  reject(id: string): ApprovalRecord | undefined
  /**
   * 消费一次批准：`granted` 且动作+载荷摘要一致 ⇒ `consumed` 并返回 true；否则 false。
   * @param id - 审批 id。
   * @param action - 本次动作。
   * @param payload - 本次载荷。
   * @returns 是否放行。
   */
  consume(id: string, action: OfficeAction, payload: unknown): boolean
}

/** 稳定序列化（对象键排序），供摘要用。 */
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`
}

/** 动作 + 载荷的稳定摘要。 */
export function digestOf(action: OfficeAction, payload: unknown): string {
  return createHash('sha1').update(stable({ action, payload })).digest('hex')
}

/** 审批存储的可选接线（持久化 / 恢复）。 */
export interface ApprovalStoreOptions {
  /** 状态变更回调（每次 request/grant/reject/consume 后整份回写，供跨重启）。 */
  readonly persist?: (records: readonly ApprovalRecord[]) => void
  /** 初始记录（从磁盘恢复）。 */
  readonly initial?: readonly ApprovalRecord[]
}

/**
 * 造审批存储。
 * @param newId - id 生成器（默认 `randomUUID`）。
 * @param options - 持久化与恢复（缺省纯内存）。
 * @returns 存储。
 */
export function createApprovalStore(newId: () => string = randomUUID, options: ApprovalStoreOptions = {}): ApprovalStore {
  const map = new Map<string, ApprovalRecord>()
  for (const record of options.initial ?? []) map.set(record.id, { ...record })
  const notify = (): void => { options.persist?.([...map.values()].map((record) => ({ ...record }))) }
  return {
    request(action, payload) {
      const digest = digestOf(action, payload)
      for (const record of map.values()) {
        if (record.status === 'pending' && record.action === action && record.digest === digest) return record
      }
      const record: ApprovalRecord = { id: newId(), action, digest, status: 'pending' }
      map.set(record.id, record)
      notify()
      return record
    },
    get: (id) => { const record = map.get(id); return record === undefined ? undefined : { ...record } },
    list: () => [...map.values()].map((record) => ({ ...record })),
    grant(id) {
      const record = map.get(id)
      if (record === undefined || record.status !== 'pending') return undefined
      record.status = 'granted'
      notify()
      return { ...record }
    },
    reject(id) {
      const record = map.get(id)
      if (record === undefined || record.status !== 'pending') return undefined
      record.status = 'rejected'
      notify()
      return { ...record }
    },
    consume(id, action, payload) {
      const record = map.get(id)
      if (record === undefined || record.status !== 'granted') return false
      if (record.action !== action || record.digest !== digestOf(action, payload)) return false
      record.status = 'consumed'
      notify()
      return true
    },
  }
}
