/**
 * M1 审批层台账（设计 §3.2 / §3.6 / §3.4.1）。
 *
 * 落处是内核的 `ctx.storageDomain`，不是自建的旁路 DB：领域的每次写入在 resolve 之前
 * 已经持久，后端写失败则内存态不动 —— 这正是「台账写失败必须拒掉这次审批」（E12）
 * 能够成立的前提，我们不自己实现第二套 durability。
 *
 * 状态迁移用 `KvTable.update`：它排在领域唯一的写链上，`fn` 看到的一定是它那个队列槽
 * 上的当前值，所以「读—判—写」天然串行，等价于一次 CAS，不需要事务也不需要排队闸。
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'

/** 一次审批请求的生命周期状态（§3.2）。 */
export const approvalStatuses = ['pending', 'approved', 'rejected', 'expired', 'recalled', 'consumed'] as const
export const riskLevels = ['L0', 'L1', 'L2', 'L3', 'L4'] as const
export type RiskLevel = typeof riskLevels[number]

const requestSchema = z.object({
  requestId: z.string(),
  sessionId: z.string(),
  callId: z.string().optional(),
  rootCallId: z.string().optional(),
  tenantId: z.string(),
  toolName: z.string(),
  riskLevel: z.enum(riskLevels),
  actionSummary: z.string(),
  /** 取自 `tools/pre-execute` 的 `exec.arguments` —— 内核的审批事件里没有参数（F4）。 */
  toolArgs: z.unknown(),
  /** 透传给卡片的原文，responder 不重组（D8）。 */
  displayReason: z.string(),
  status: z.enum(approvalStatuses),
  askedAt: z.number(),
  windowEndsAt: z.number(),
  expiresAt: z.number(),
  decidedBy: z.string().nullable(),
  decidedAt: z.number().nullable(),
})
export type ApprovalRequestRecord = z.infer<typeof requestSchema>

/**
 * 这条审批**还开着批准之门**吗。
 *
 * `expired` 在 M1 里有两种含义，只看状态分不开：同步窗口结束（转后台等 IM 批准，门还开）
 * 与批件到期（安全阀落下，门关上）。分的唯一依据是 `expiresAt` —— 回调路由的准入判定用的就是
 * 这两个条件（`callback-route.ts`），催办与重启补武装必须用同一个判定，否则两处会漂移。
 * `recalled` 同理由：询问作废不等于批准作废。
 */
export function isDecidable(record: ApprovalRequestRecord, at: number): boolean {
  if (record.expiresAt <= at) return false
  return record.status === 'pending' || record.status === 'expired' || record.status === 'recalled'
}

/**
 * 这条记录还在等一个裁决吗。
 *
 * `pending` 即使已过 `expiresAt` 也算：批准的门确实关了，但还欠一次「作废」这笔动作
 * （重启扫描跳过它就等于永远停在那句「已转后台等待审批」上）。超窗转后台写成的 `expired`
 * 与 `recalled` 在 `expiresAt` 之前同样还在等 —— 那正是 §3.5 的催办要服务的状态。
 * `approved` 不在这个谓词里：有人批了，催办就成了打扰；它欠的是作废，由调用方单独判。
 */
export function awaitsDecision(record: ApprovalRequestRecord, at: number): boolean {
  if (record.status === 'pending') return true
  return (record.status === 'expired' || record.status === 'recalled') && record.expiresAt > at
}

/**
 * 这条记录还欠一次「收摊」吗 —— 到点作废那一支的判定。
 *
 * 和 `awaitsDecision` 不同，这里**不看 `expiresAt`**：作废登记的时刻本身就是 `expiresAt`，
 * 到点时任何「还没有终局」的状态都要被收走，包括已经过了有效期的 `pending`（那条批准之门关了，
 * 但记录还挂在账上，卡片也还挂在会话里）。`rejected` / `consumed` 才是已经有人给了结局。
 */
export function awaitsExpiry(record: ApprovalRequestRecord): boolean {
  return record.status === 'pending'
    || record.status === 'expired'
    || record.status === 'recalled'
    || record.status === 'approved'
}

const grantSchema = z.object({
  grantId: z.string(),
  requestId: z.string(),
  toolName: z.string(),
  argsDigest: z.string(),
  consumes: z.number().int().default(1),
  grantedAt: z.number(),
  grantExpiresAt: z.number(),
})
export type GrantRecord = z.infer<typeof grantSchema>

const callIndexSchema = z.object({
  callId: z.string(),
  requestId: z.string(),
})
export type CallIndexRecord = z.infer<typeof callIndexSchema>

/**
 * 「有人想批，但没批成」的审计行（E5）。
 *
 * 它和 `requests` 分开是一张**只追加**的表：审批记录描述一个动作的结局，
 * 而拒绝尝试是同一记录上可以发生 N 次的事件，塞进主记录就得覆盖字段（违反 §4「审计不可改」）。
 */
export const denialReasons = ['not-approver', 'approvers-unresolvable', 'tenant-mismatch'] as const
const denialSchema = z.object({
  denialId: z.string(),
  requestId: z.string(),
  tenantId: z.string(),
  /** 尝试者，不是决策者 —— 这一行的存在不代表任何决定。 */
  openId: z.string(),
  at: z.number(),
  reason: z.enum(denialReasons),
})
export type DenialRecord = z.infer<typeof denialSchema>

/**
 * 卡片句柄（§8 第 6 步）。
 *
 * 渠道侧的事实必须和决策落在同一本账里，否则进程重启之后就再也找不到那张卡：
 * 「已批准」的就地改字、撤回、催办重推都要按 `messageId` 打给 IM。
 * 主键取 `requestId` —— 一条审批一组句柄（推给几个审批人就有几条消息），催办重推是同一条记录的又一次投递（幂等键见渠道侧）。
 */
const cardSchema = z.object({
  requestId: z.string(),
  /** 一条审批可能推给多个审批人，每个人一条消息 —— 改字/撤回要逐个打，句柄只能是列表。 */
  messageIds: z.array(z.string()),
  recipientIds: z.array(z.string()),
  pushedAt: z.number(),
})
export type CardHandleRecord = z.infer<typeof cardSchema>

/**
 * 催办/过期的告警登记（§3.5）。
 *
 * 内核 `schedule` 的 job id 由它自己生成、正文不能带元数据（`ScheduleRecord` 各分支按精确键集
 * 校验，多一个键就整个域拒开），所以「哪个告警属于哪条审批」这张对照表只能我们自己记。
 * 记在台账里而不是内存里，是因为告警必须活过重启 —— 这正是用 `schedule` 而不是 `setTimeout` 的理由。
 */
export const sweepKinds = ['remind', 'expire'] as const
export type SweepKind = typeof sweepKinds[number]
export const sweepStatuses = ['armed', 'fired', 'cancelled'] as const
const sweepSchema = z.object({
  sweepId: z.string(),
  requestId: z.string(),
  kind: z.enum(sweepKinds),
  at: z.number(),
  /** 告警层的 job id；`null` = 登记了但还没武装成功（此时撤销只需删掉这一行）。 */
  alarmId: z.string().nullable(),
  status: z.enum(sweepStatuses),
  armedAt: z.number(),
  firedAt: z.number().nullable(),
})
export type SweepRecord = z.infer<typeof sweepSchema>

/**
 * `layout: 'per-record'`：台账只增不减，whole-unit 布局会让每一次点击重写整本账。
 * 权威数据不接受 `invalidRecords: 'backup-and-skip'` —— 记录不合 schema 时必须让 open 失败。
 *
 * 域名/表名受 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/` 约束，**不接受连字符**，
 * 所以设计 §3.2 里草拟的 `office-approval-ledger` 在实现时改成下划线。
 */
export const approvalLedgerDomain = defineDomain({
  name: 'office_approval_ledger',
  version: 1,
  layout: 'per-record',
  tables: {
    requests: domainTable<string, ApprovalRequestRecord>(requestSchema),
    grants: domainTable<string, GrantRecord>(grantSchema),
    call_index: domainTable<string, CallIndexRecord>(callIndexSchema),
    denials: domainTable<string, DenialRecord>(denialSchema),
    cards: domainTable<string, CardHandleRecord>(cardSchema),
    sweeps: domainTable<string, SweepRecord>(sweepSchema),
  },
})

export type LedgerDomain = Domain<typeof approvalLedgerDomain>

export interface TransitionGuard {
  /** 只有当前状态在此集合内才迁移。 */
  from: readonly ApprovalRequestRecord['status'][]
  to: ApprovalRequestRecord['status']
  /** 迁移时一并覆盖的字段。 */
  set?: Partial<Pick<ApprovalRequestRecord, 'decidedBy' | 'decidedAt'>>
}

/** 授权一次性发放的入参。 */
export interface NewGrant {
  grantId: string
  toolName: string
  argsDigest: string
  grantExpiresAt: number
}

/**
 * 台账状态变更的观察者：拿到的是**迁移之后**的那条记录。
 *
 * 它是催办/过期告警的唯一挂载点（§3.5）——「什么时候该武装」「什么时候该撤销」
 * 取决于台账走到了哪一步，而闸、responder、回调路由、恢复路径各自都在改状态。
 * 让四处都回头调 sweeper 会把审批层焊成一团；让 sweeper 订阅这一本账则不用改它们。
 *
 * 通知是**不等**的：回调路由有 3 秒义务、同步窗口在等结局，观察者跑在写链之外。
 * 观察者的同步抛出被接住送进 `onObserverError`，绝不冒回给写入方 ——
 * 账已经落好了，一个订阅者的故障不该让那次审批失败。
 */
export type LedgerListener = (record: ApprovalRequestRecord) => void

export interface LedgerOptions {
  onObserverError?: (error: unknown, record: ApprovalRequestRecord) => void
}

/**
 * 把参数规范化成可比较的形状：对象递归按 key 排序，数组保序。
 * U1 实测同一组参数两次调用的键序不同（`{file_path, content}` vs `{content, file_path}`），
 * 不归一就会产生「参数没变但 digest 变了」的假阴性。
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key])
    return out
  }
  return value
}

/**
 * 授权指纹（§3.4.1）。
 *
 * `justification` 必须剔除：它是模型自撰的说明文字，U1 的 11 轮每次重放都重写了它，
 * 计入 digest 等于让每一次延迟批准都 miss。`sandbox_permissions` 必须计入：
 * 批准 `danger-full-access` 不等于批准别的模式。
 */
export function argsDigest(args: Record<string, unknown>): string {
  const authorized = canonicalize({ ...args, justification: undefined })
  return createHash('sha256').update(JSON.stringify(authorized)).digest('hex')
}

/** 审批台账：读同步自内存，写经领域写链持久化。 */
export class ApprovalLedger {
  readonly #listeners = new Set<LedgerListener>()

  constructor(
    private readonly domain: LedgerDomain,
    private readonly options: LedgerOptions = {},
  ) {}

  private get requests() {
    return this.domain.table('requests')
  }

  private get callIndex() {
    return this.domain.table('call_index')
  }

  get grants() {
    return this.domain.table('grants')
  }

  /** 拒绝尝试是只追加的审计流，产品侧不做按 `requestId` 的查询，所以不建索引表。 */
  get denials() {
    return this.domain.table('denials')
  }

  /** 落一条新请求。后端写失败时这里 reject，且内存里不会留下半个状态（E12）。 */
  async create(request: ApprovalRequestRecord): Promise<ApprovalRequestRecord> {
    await this.requests.put(request.requestId, request)
    this.#notify(request.requestId)
    return request
  }

  /**
   * ask 快照：记录 + `callId → requestId` 索引。
   *
   * 必须落在闸这一侧：内核的审批事件只有 6 个字段，**没有工具参数**（F4），
   * 而 §3.4.1② 要求快照取自「即将被闸的那次调用」—— 只有 `tools/pre-execute`
   * 这一刻看得到 `exec.arguments`。索引表是因为 responder 手上只有 `callId`，
   * 而台账主键是不可猜的 `requestId`。
   *
   * 索引写失败时 best-effort 收回记录再 reject，让 risk-gate 走拒绝路径（E12）。
   * 收回也可能失败（后端整体坏了），那时留下一条没人认领的 pending —— 它是惰性的：
   * 没有对应的询问在飞，也**不会**有催办告警被武装（状态变更通知排在两次写都落完之后才发），
   * 最坏是在审计导出里多一行。
   */
  async snapshot(request: ApprovalRequestRecord): Promise<ApprovalRequestRecord> {
    await this.requests.put(request.requestId, request)
    if (request.callId === undefined) {
      this.#notify(request.requestId)
      return request
    }
    try {
      await this.callIndex.put(request.callId, { callId: request.callId, requestId: request.requestId })
    } catch (error) {
      await this.requests.delete(request.requestId).catch(() => {})
      throw error
    }
    this.#notify(request.requestId)
    return request
  }

  /** responder / 回调路由靠它把内核带来的 `callId` 换回台账主键。 */
  findByCall(callId: string): ApprovalRequestRecord | undefined {
    const index = this.callIndex.get(callId)
    return index === undefined ? undefined : this.requests.get(index.requestId)
  }

  get(requestId: string): ApprovalRequestRecord | undefined {
    return this.requests.get(requestId)
  }

  /** 拒绝尝试落审计（E5）。只追加，绝不改动 `requestId` 那条记录的状态。 */
  async recordDenial(denial: DenialRecord): Promise<void> {
    await this.denials.put(denial.denialId, denial)
  }

  denial(denialId: string): DenialRecord | undefined {
    return this.denials.get(denialId)
  }

  get cards() {
    return this.domain.table('cards')
  }

  get sweeps() {
    return this.domain.table('sweeps')
  }

  /**
   * 记一张已送达卡片的句柄（§8 第 6 步）。
   *
   * 覆盖写是有意的：同一 `requestId` 的催办重推会换 `messageId`，而"当前能改的那张卡"
   * 只能有一个 —— 旧句柄对应的消息由渠道自己撤回，不在这里留两个指向。
   */
  async putCard(handle: CardHandleRecord): Promise<void> {
    await this.cards.put(handle.requestId, handle)
  }

  cardHandle(requestId: string): CardHandleRecord | undefined {
    return this.cards.get(requestId)
  }

  /**
   * 一个会话的全部审批记录 —— 卡片上的「本次会话第 N 次放宽权限」次数靠它数出来（§4 人因防线）。
   * 这是唯一允许把台账当只读聚合查询用的地方：它不参与决策，只把已经落账的事实呈现给人。
   */
  requestsOf(sessionId: string): ApprovalRequestRecord[] {
    return [...this.requests.entries()]
      .map(([, record]) => record)
      .filter(record => record.sessionId === sessionId)
  }

  /**
   * 重启后还要补登记催办/作废的两类记录：
   * - 仍欠裁决的（`pending`，以及 `expiresAt` 之前转后台的 `expired` / `recalled`）→ 催办 + 作废都欠；
   * - `approved` 且没被重放消费掉的 → 只欠作废（催办会打扰已经批了的人）。
   */
  openRequests(now: number): ApprovalRequestRecord[] {
    return [...this.requests.entries()]
      .map(([, record]) => record)
      .filter(record => awaitsDecision(record, now) || record.status === 'approved')
  }

  /** 台账状态变更订阅点；返回撤销句柄。 */
  onChanged(listener: LedgerListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #notify(requestId: string): void {
    if (this.#listeners.size === 0) return
    const record = this.requests.get(requestId)
    if (record === undefined) return
    for (const listener of [...this.#listeners]) {
      try {
        listener(record)
      } catch (error) {
        this.options.onObserverError?.(error, record)
      }
    }
  }

  /**
   * 登记一次告警武装。返回 `false` = 这一条已经登记过，调用方**不该**再去落第二个定时器。
   *
   * 内存预判 + 主键覆盖写：这一对挡不住两个并发 `arm` 都看到"没登记过"的极端时序，
   * 但那一时序的后果被消费侧的 `claimSweep` 吃掉（多出来的告警到点只会被记为已消费一次，
   * 第二次拿到 `false`），所以这里不必再加一层排队闸 —— §3.6 的取向是幂等消费，不是分布式原子性。
   */
  async armSweep(sweep: SweepRecord): Promise<boolean> {
    if (this.sweeps.get(sweep.sweepId) !== undefined) return false
    await this.sweeps.put(sweep.sweepId, sweep)
    return true
  }

  sweep(sweepId: string): SweepRecord | undefined {
    return this.sweeps.get(sweepId)
  }

  sweepsOf(requestId: string): SweepRecord[] {
    return [...this.sweeps.entries()]
      .map(([, row]) => row)
      .filter(row => row.requestId === requestId)
  }

  /** 还在武装的告警行 —— 投递对账靠它把 job id 换回登记行。 */
  armedSweeps(): SweepRecord[] {
    return [...this.sweeps.entries()]
      .map(([, row]) => row)
      .filter(row => row.status === 'armed')
  }

  /**
   * 这条审批还留着**一张没被消费掉的批件**吗。
   *
   * §3.5 在 `approved` 上留下 `expire` 告警的**唯一**理由，是要在 `expiresAt` 收回一张
   * 「批了却永远没被重放」的批件（安全阀）。同步窗口内的批准从不落批件、重放成功后批件即被删，
   * 这两种 `approved` 都没有可收回的东西 —— 此时武装/留着 `expire` 不只是白挂一条侧栏自动化，
   * 而是到点会把一条**已完成**的批准误判成作废（状态被改、发起人收到「因未获批准，任务未完成」）。
   * 作废这条动作因此只能认「有没有批件」，不能只认状态。
   */
  hasOutstandingGrant(requestId: string): boolean {
    for (const [, grant] of this.grants.entries()) {
      if (grant.requestId === requestId) return true
    }
    return false
  }

  /**
   * 放弃一次**还没武装成功**的登记（`alarmId` 还是 `null`）—— 让下一次扫描能重试。
   *
   * 已有 job id 的行不走这条路：那是要撤销的告警，删掉就丢了"曾经武装过"的痕迹，
   * 而且告警层可能已经把这个 id 记在别处，撤销必须走 `cancelSweep` 拿到 id。
   */
  async forgetSweep(sweepId: string): Promise<void> {
    const current = this.sweeps.get(sweepId)
    if (current === undefined || current.alarmId !== null) return
    await this.sweeps.delete(sweepId)
  }

  /** 告警层拿到了它自己的 job id 之后回填登记（写链上的 `update`）。 */
  async attachAlarm(sweepId: string, alarmId: string): Promise<void> {
    await this.sweeps.update(sweepId, current => ({ ...current, alarmId }))
  }

  /**
   * 认领一次到期（幂等消费）：只有把 `armed → fired` 赢下来的那一次才该去做重推/作废动作。
   * 内核 `schedule` 明确"崩溃与提交之间不保证恰好一次"，所以同一条告警可能被交到两次。
   */
  async claimSweep(sweepId: string, at: number): Promise<boolean> {
    if (this.sweeps.get(sweepId)?.status !== 'armed') return false
    let won = false
    await this.sweeps.update(sweepId, current => {
      if (current.status !== 'armed') return current
      won = true
      return { ...current, status: 'fired', firedAt: at }
    })
    return won
  }

  /**
   * 撤销登记：决策已定，之后的告警一律不该再动作。
   *
   * `fired` 的行**不回滚** —— 它是一次已经发生的事件，改掉它等于抹掉"我们催过办"这条审计；
   * 只把还武装着的行标成 `cancelled` 并把 job id 交给调用方去删。
   */
  async cancelSweep(sweepId: string): Promise<string | undefined> {
    const current = this.sweeps.get(sweepId)
    if (current === undefined || current.status !== 'armed') return undefined
    let alarmId: string | undefined
    await this.sweeps.update(sweepId, row => {
      if (row.status !== 'armed') return row
      alarmId = row.alarmId ?? undefined
      return { ...row, status: 'cancelled' }
    })
    return alarmId
  }

  /**
   * 带守卫的状态迁移，返回**本次是否赢**。同一 `requestId` 的第二次点击必然 false（E4）——
   * 重复回调、多人同批、用户连点都在这一层挡掉。
   */
  async transition(requestId: string, guard: TransitionGuard): Promise<boolean> {
    const won = await this.#migrate(requestId, guard)
    // 只有真的迁动了才通知：输掉 CAS 的那一方没有改变任何事实，通知它等于让订阅者把同一个
    // 状态看成变过两次。
    if (won) this.#notify(requestId)
    return won
  }

  /**
   * 迁移的**不通知**内核：写链上的权威判定与 `transition` 完全一致，只是不发状态变更通知。
   *
   * 单独拆出来只为一处 —— `approve` 必须让订阅者看到「批件已经落好」的 `approved`，
   * 而 `transition` 会在写批件之前就把通知发出去。催办订阅靠「有没有批件」决定 `expire` 去留
   * （`hasOutstandingGrant`），若在批件落账前通知，同步批准与迟到批准在这一刻看起来一模一样，
   * 订阅者就没法区分、只能一律留着 `expire` —— 那正是 #38 的幽灵自动化。
   */
  async #migrate(requestId: string, guard: TransitionGuard): Promise<boolean> {
    const current = this.requests.get(requestId)
    // 预判只为了不让注定失败的迁移去重写一遍磁盘（点击洪峰是顺序到达的，内存态早已更新）；
    // 真正的判定在 update 的 fn 里做，那才是写链上的权威槽位。
    if (current === undefined || !guard.from.includes(current.status)) return false
    let won = false
    await this.requests.update(requestId, record => {
      if (!guard.from.includes(record.status)) return record
      won = true
      return { ...record, status: guard.to, ...guard.set }
    })
    return won
  }

  /**
   * 批准并授权一次重放（D7）。
   *
   * 先迁状态再写 grant；grant 写失败（E12）就把状态退回 `expired` 作为补偿 ——
   * `expired` 仍在 `approve` 的可迁移集合里，所以用户重新点一次仍能成功，
   * 而不是留下一条「已批准但永远等不到授权」的死账。
   */
  async approve(
    requestId: string,
    input: { decidedBy: string; now: number; grant: NewGrant },
  ): Promise<{ won: boolean; grant?: GrantRecord }> {
    const won = await this.#migrate(requestId, {
      from: ['pending', 'expired', 'recalled'],
      to: 'approved',
      set: { decidedBy: input.decidedBy, decidedAt: input.now },
    })
    if (!won) return { won: false }
    const grant: GrantRecord = {
      grantId: input.grant.grantId,
      requestId,
      toolName: input.grant.toolName,
      argsDigest: input.grant.argsDigest,
      consumes: 1,
      grantedAt: input.now,
      grantExpiresAt: input.grant.grantExpiresAt,
    }
    try {
      await this.grants.put(grant.grantId, grant)
    } catch (error) {
      // 退回 `expired` 用带通知的 `transition`：这条记录从未真正进入 `approved`（批件没落），
      // 但状态已迁成 approved，收回必须让订阅者看见，否则它按 approved 留着告警。
      await this.transition(requestId, { from: ['approved'], to: 'expired' })
      throw error
    }
    // 批件落好之后**才**通知：订阅者据此判「这次批准留下了批件 ⇒ `expire` 该留着」。
    this.#notify(requestId)
    return { won: true, grant }
  }

  /**
   * 收回一张还没用掉的批件。
   *
   * 两个调用方都需要它，而且都是安全要求而不是清理：
   * ①批准由还在等的同步窗口当场兑现（动作这一轮就执行），批件若留着，之后任何一次
   * 同工具同参数的调用都会不问自取地执行；②会话唤醒失败时先把批件收回，再把记录
   * 退回可批准状态，用户重新点一次仍能成。
   *
   * 删除与「消费完即删」是同一条路径，不额外破坏审计：批件存在过的事实由
   * `requests` 那条记录的 `approved` 状态与 `decidedBy` 承载。
   */
  async revokeGrant(grantId: string): Promise<void> {
    await this.grants.delete(grantId)
  }

  /**
   * 收回某条审批留下的、还没被重放消费掉的批件（§3.5 的「审批作废 ⇒ grants 不再受理」）。
   *
   * 消费侧本来就有 `grantExpiresAt` 这道门，所以这一步不是安全边界，而是审计卫生：
   * 作废之后账上还躺着一张能用的批件，导出报表的人会问"这条到底能不能执行"。
   * grant 的 id 是批准时生成的随机值，所以按 `requestId` 反查 —— 授权发放时记的是哪条审批。
   */
  async revokeGrantsFor(requestId: string): Promise<number> {
    const stale = [...this.grants.entries()]
      .filter(([, grant]) => grant.requestId === requestId)
      .map(([grantId]) => grantId)
    for (const grantId of stale) await this.grants.delete(grantId)
    return stale.length
  }

  /**
   * 消费一次授权：digest 失配（E9）或已过期（E10）都返回 undefined，调用方回落标准询问。
   * 守卫同样写在 fn 里，所以两个重放 turn 并发消费同一 grant 只会赢一个。
   */
  async consumeGrant(
    toolName: string,
    digest: string,
    now: number,
  ): Promise<GrantRecord | undefined> {
    const candidates = [...this.grants.entries()]
      .filter(([, grant]) =>
        grant.toolName === toolName
        && grant.argsDigest === digest
        && grant.consumes > 0
        && grant.grantExpiresAt > now)
      .sort(([, a], [, b]) => a.grantedAt - b.grantedAt)
    for (const [grantId] of candidates) {
      let consumed: GrantRecord | undefined
      const next = await this.grants.update(grantId, current => {
        if (current.consumes < 1 || current.grantExpiresAt <= now) return current
        consumed = { ...current, consumes: current.consumes - 1 }
        return consumed
      })
      if (consumed === undefined) continue
      // 一次性的 grant 用完即删；删除失败不影响正确性 —— consumes 已经是 0，没人能再消费。
      if (next.consumes === 0) await this.grants.delete(grantId)
      return next
    }
    return undefined
  }
}
