/**
 * M1 催办与过期（设计 §3.5、D6，§8 第 6 步）。
 *
 * 一条 `pending` 的审批有两个"没人管"的时刻要处理：30 分钟没人看见（催办重推），
 * 到 `expiresAt` 永远没人批（作废）。两者都必须活过进程重启 —— 这正是用内核
 * `ctx.schedule` 而不是 `setTimeout` 的唯一理由（D6）。
 *
 * 三条读码/实测换来的形状约束：
 * - `schedule` 的 job **不能带元数据**：`ScheduleRecord` 每个分支按精确键集校验，多一个键
 *   整个域拒开（`packages/schedule/schedule/src/domain.ts:151-154`），job id 也由内核生成。
 *   所以「哪个告警属于哪条审批」这张对照表只能我们自己记 —— 记在 `sweeps` 表里，跟台账同生共死。
 * - `schedule` **没有幂等键**，也没有失败重试（包内规约明确禁止通用重试循环）：投递是至少一次，
 *   崩溃可能重投。所以到期动作必须靠 `armed → fired` 的 CAS 认领，而不是指望定时器只响一次。
 * - 投递的**唯一形态是给会话发一条用户消息**（`source.kind: 'schedule'`）。平台侧的动作不靠解析
 *   那条消息：投递成功后任务转为 `inactive` 并留下 `lastDelivery` 回执，`catalog()` 读得到 ——
 *   对账走回执，正文只负责让模型看懂发生了什么。
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ScheduleId } from '@deepseek-ai/dsh-schedule'
import { awaitsDecision, awaitsExpiry, isDecidable, type ApprovalLedger, type ApprovalRequestRecord, type SweepKind, type SweepRecord } from './ledger.ts'

/** §3.5：`askedAt + 30min` 重推一次。 */
export const defaultRemindAfterMs = 30 * 60_000

/** 一次到期的去处；`skipped` 表示这条告警已经不属于任何还在等的审批。 */
export type SweepOutcome = 'reminded' | 'expired' | 'skipped' | 'unknown'

export interface SweeperFailure {
  readonly sweepId: string
  readonly requestId: string
  readonly kind: SweepKind
  readonly stage: 'arm' | 'cancel' | 'remind' | 'expire'
  readonly error: unknown
}

/**
 * 持久告警端口。生产实现是 `ctx.schedule`（`createScheduleAlarms`），测试实现手动触发 ——
 * 决策核与定时器实现分开，是因为 `schedule` 的 `at` 只接受**严格未来**的时刻，
 * 而「已经过期」这条分支必须在测试里跑到。
 */
export interface SweeperAlarms {
  arm: (input: {
    sessionId: string
    requestId: string
    kind: SweepKind
    at: number
    title: string
    prompt: string
  }) => Promise<string>
  cancel: (alarmId: string, sessionId: string) => Promise<void>
}

/** 到期之后真正要做的两件产品动作，由渠道/通知层实现（§8 第 6 步的飞书卡片在这里）。 */
export interface SweeperTargets {
  /** 卡片重推一次给审批人。 */
  remind: (record: ApprovalRequestRecord) => Promise<void>
  /** 卡片标「已过期」并通知发起人「因未获批准，任务未完成」。 */
  expire: (record: ApprovalRequestRecord) => Promise<void>
}

export interface SweeperOptions {
  ledger: ApprovalLedger
  alarms: SweeperAlarms
  targets: SweeperTargets
  now?: () => number
  remindAfterMs?: number
  onFailure?: (event: SweeperFailure) => void
}

/**
 * 告警登记行的主键。
 *
 * 分隔符只能是 `_`：`storage-json` 对 per-record 主键有 `^[a-zA-Z0-9_-]+$` 的路径安全约束
 * （冒号会让整条登记直接写不下去），而 `requestId` 是 UUID 或我们自造的 `req-x`，都不含 `_`，
 * 所以 `requestId_remind` / `requestId_expire` 既合法又唯一。
 */
export function sweepIdOf(requestId: string, kind: SweepKind): string {
  return `${requestId}_${kind}`
}

/** 内核限 120 字且会 trim；超了不是报错而是要看懂，所以按字数硬截并留省略号。 */
function alarmTitle(kind: SweepKind, record: ApprovalRequestRecord): string {
  const label = kind === 'remind' ? '审批催办' : '审批过期'
  const summary = record.actionSummary.length > 80 ? `${record.actionSummary.slice(0, 79)}…` : record.actionSummary
  const title = `${label} · ${summary}`
  return title.length <= 120 ? title : `${title.slice(0, 119)}…`
}

/**
 * 告警正文 = 模型可见的那条消息（`schedule` 只会做这件事）。
 *
 * 两条规约在这里同时成立：内核 `schedule` 的包内规约禁止把投递描述成"已执行"，
 * 而 §3.4.1 的实测结论是模型会照消息里的指令行动 —— 所以正文必须明确
 * "这不是新指令""不要重复发起""不要替审批人批准"，否则一次催办就变成一次越权诱因。
 */
function alarmPrompt(kind: SweepKind, record: ApprovalRequestRecord): string {
  const line = `编号 ${record.requestId}（${record.actionSummary}）`
  return kind === 'remind'
    ? `[平台催办] ${line} 仍在等待批准，平台已重新提醒审批人。这不是新的用户指令：不要重复发起同一个动作，也不要代替审批人批准。`
    : `[平台通知] ${line} 的请求因未获批准已作废。不要重复发起；如需继续，请向用户说明并等待指示。`
}

export function createApprovalSweeper(options: SweeperOptions) {
  const now = options.now ?? (() => Date.now())
  const remindAfterMs = options.remindAfterMs ?? defaultRemindAfterMs
  const { ledger, alarms, targets } = options

  function report(row: Pick<SweepRecord, 'sweepId' | 'requestId' | 'kind'>, stage: SweeperFailure['stage'], error: unknown): void {
    options.onFailure?.({ ...row, stage, error })
  }

  async function armKind(record: ApprovalRequestRecord, kind: SweepKind, at: number): Promise<void> {
    const sweepId = sweepIdOf(record.requestId, kind)
    // 已经登记过就不武装第二个：`schedule` 没有幂等键，重复武装的唯一后果是多一条打扰。
    // 已取消/已触发的行留在账上是审计，重开一条审批不是这里的职责（那是新的 requestId）。
    if (ledger.sweep(sweepId) !== undefined) return
    const created = await ledger.armSweep({
      sweepId,
      requestId: record.requestId,
      kind,
      at,
      alarmId: null,
      status: 'armed',
      armedAt: now(),
      firedAt: null,
    })
    if (!created) return
    // 时刻已过（重启后补武装最常见）：不抛 `not_future`，而是当场把该做的事做掉。
    if (at <= now()) {
      await fire(sweepId)
      return
    }
    try {
      const alarmId = await alarms.arm({
        sessionId: record.sessionId,
        requestId: record.requestId,
        kind,
        at,
        title: alarmTitle(kind, record),
        prompt: alarmPrompt(kind, record),
      })
      await ledger.attachAlarm(sweepId, alarmId)
    } catch (error) {
      // 登记删掉而不是留一行 `armed` 的空壳：没有 job id 的行会让后续扫描以为"已经武装过"，
      // 于是这条审批永远等不到催办 —— 活性故障不能伪装成已登记。
      await ledger.forgetSweep(sweepId).catch(() => {})
      report({ sweepId, requestId: record.requestId, kind }, 'arm', error)
    }
  }

  /** 武装两个时刻：催办在 `askedAt + 30min`，作废在 `expiresAt`。 */
  async function arm(record: ApprovalRequestRecord): Promise<void> {
    // 判定用 `awaitsDecision` 而不是 `status === 'pending'`：超窗转后台的 `expired` 才是这条主路径上
    // 真正等人批的状态，重启后不给它补武装，§3.5 的催办就永远不会发生。
    if (!awaitsDecision(record, now())) return
    await armKind(record, 'remind', record.askedAt + remindAfterMs)
    await armKind(record, 'expire', record.expiresAt)
  }

  /**
   * 撤销。`keepExpire` 用于「已经批准但还没重放」：那一刻起催办是打扰，
   * 而批件仍然要在 `expiresAt` 被作废 —— §3.5 的安全阀不能因为批了就关掉。
   */
  async function settle(requestId: string, keepExpire = false): Promise<void> {
    const record = ledger.get(requestId)
    for (const row of ledger.sweepsOf(requestId)) {
      if (row.status !== 'armed') continue
      if (keepExpire && row.kind === 'expire') continue
      const alarmId = await ledger.cancelSweep(row.sweepId)
      if (alarmId === undefined || record === undefined) continue
      try {
        await alarms.cancel(alarmId, record.sessionId)
      } catch (error) {
        // 行已经标成 `cancelled`，所以这个残留 job 到点也只会拿到 `skipped`；
        // 撤销失败是资源泄漏，不是正确性故障 —— 报告而不重试。
        report(row, 'cancel', error)
      }
    }
  }


  /**
   * 一次到期。幂等：只有把 `armed → fired` 赢下来的那一次才动手。
   *
   * 顺序是「先看台账还等不等，再认领，再动手」：反过来（先认领再看）会让一条
   * 已经批准完成的审批把 `remind` 行吃成 `fired`，审计里就留下一次"催过但没催"的记录。
   */
  async function fire(sweepId: string): Promise<SweepOutcome> {
    const row = ledger.sweep(sweepId)
    if (row === undefined) return 'unknown'
    const record = ledger.get(row.requestId)
    if (record === undefined) return 'unknown'
    if (row.status !== 'armed') return 'skipped'

    const at = now()
    // 催办只在批准之门还开着的时候打扰（过期之后催一条批不动的审批是纯打扰）；
    // 作废反过来收的是「还没有终局」的记录：到点这一刻 pending、recalled，或超窗转后台的
    // expired 都要收摊 —— 最后那种没有状态要迁，只欠收回批件和通知卡片。
    // `approved` 独有一条：§3.5 在批准上留作废，**唯一**目的是收回一张没被重放的批件。
    // 没有批件的 `approved`（同步窗口内批准、或批件已被重放消费）没有东西可收，到点若照作废
    // 就是把一条**已完成**的批准改写成 expired、给发起人发一句「因未获批准，任务未完成」——
    // #38 的真身。判定因此认「有没有批件」而不是状态，不 action 时把告警就地撤销（幽灵消失）。
    const actionable = row.kind === 'remind'
      ? isDecidable(record, at)
      : record.status === 'approved'
        ? ledger.hasOutstandingGrant(record.requestId)
        : awaitsExpiry(record)
    if (!actionable) {
      await ledger.cancelSweep(sweepId)
      return 'skipped'
    }
    if (!(await ledger.claimSweep(sweepId, now()))) return 'skipped'

    if (row.kind === 'remind') {
      try {
        await targets.remind(record)
      } catch (error) {
        report(row, 'remind', error)
        return 'skipped'
      }
      return 'reminded'
    }

    // 作废：先落账再动手。`grants` 一并收回 —— 批了却没重放的批件若留着，
    // 过期之后任何一次同工具同参数的调用都可能把它捡走（§3.5 的安全阀在这里落地）。
    try {
      const won = await ledger.transition(record.requestId, { from: ['pending', 'approved'], to: 'expired' })
      const fresh = ledger.get(record.requestId) ?? record
      // 输掉 CAS 有两种：别的裁决者刚好给了结局（那次的卡片归它更新，我们不再说话），
      // 或者记录本来就以 `expired` 停在账上（同步窗口超期那条路）—— 后者仍然欠一次作废。
      if (!won && fresh.status !== 'expired') return 'skipped'
      await ledger.revokeGrantsFor(record.requestId)
      await targets.expire(fresh)
    } catch (error) {
      report(row, 'expire', error)
      return 'skipped'
    }
    return 'expired'
  }

  /** 重启后补武装：所有还开着的审批都该有它的两个时刻。 */
  async function scanOpen(): Promise<number> {
    const open = ledger.openRequests(now())
    for (const record of open) {
      // `approved` 不再催办（有人批了）。补作废只在**确实还挂着一张没消费的批件**时做：
      // 没有批件的 `approved`（窗口内批准，或批件已被重放消费后重启）若补武装，就是重启后
      // 重新挂出 #38 那条幽灵自动化，到点还会误作废一条已完成的批准。
      if (record.status === 'approved') {
        if (ledger.hasOutstandingGrant(record.requestId)) await armKind(record, 'expire', record.expiresAt)
      } else await arm(record)
    }
    return open.length
  }

  /** 还在武装的告警：job id → 登记行。投递对账用它认领，不解析投递出去的正文。 */
  function armedAlarmIds(): Map<string, string> {
    const out = new Map<string, string>()
    for (const row of ledger.armedSweeps()) {
      if (row.alarmId !== null) out.set(row.alarmId, row.sweepId)
    }
    return out
  }

  return { arm, settle, fire, scanOpen, armedAlarmIds }
}

/**
 * 生产告警实现：`ctx.schedule` 的一次性 `at` 任务。
 *
 * `at` 用 ISO 字符串而不是 epoch —— 内核只接受 RFC 3339 时刻，且必须严格未来。
 * `drain` 是投递对账：把「已投递（有 `lastDelivery` 回执）且我们这边还记着 armed」的 job
 * 交给 sweeper 的到期动作。为什么不解析投递出去的正文：那条消息是写给模型看的，
 * 而回执是内核写进任务行的事实 —— 前者可以改措辞，后者是 `catalog()` 的稳定字段。
 */
export type SweeperCore = ReturnType<typeof createApprovalSweeper>

export function createScheduleAlarms(ctx: Context): SweeperAlarms & {
  drain: (sweeper: Pick<SweeperCore, 'armedAlarmIds' | 'fire'>) => Promise<number>
} {
  return {
    async arm(input) {
      const record = await ctx.schedule.create(SessionId(input.sessionId), {
        title: input.title,
        prompt: input.prompt,
        at: new Date(input.at).toISOString(),
      })
      return String(record.id)
    },
    /**
     * `schedule.delete` 对已经不存在的 job 返回 `{deleted:false, code:'schedule_not_found'}`
     * 而不是抛 —— 一次没删掉**没有**留下任何正确性问题：登记行此时已是 `cancelled`，
     * 残留 job 到点只会拿到 `skipped`。所以这里不把"没删掉"当失败上报。
     */
    async cancel(alarmId, sessionId) {
      await ctx.schedule.delete({ id: ScheduleId(alarmId), sessionId: SessionId(sessionId) })
    },
    async drain(sweeper) {
      const armed = sweeper.armedAlarmIds()
      if (armed.size === 0) return 0
      const entries = await ctx.schedule.catalog()
      let handled = 0
      for (const entry of entries) {
        if (entry.lastDelivery === undefined) continue
        const sweepId = armed.get(String(entry.id))
        if (sweepId === undefined) continue
        handled += 1
        await sweeper.fire(sweepId)
      }
      return handled
    },
  }
}

export interface InstallSweeperOptions {
  ledger: ApprovalLedger
  targets: SweeperTargets
  remindAfterMs?: number
  now?: () => number
  onFailure?: (event: SweeperFailure) => void
}

/**
 * 挂载：订阅台账状态变更（武装/撤销）、订阅 `schedule/changed`（投递对账）、启动时补扫。
 *
 * 订阅台账而不是让闸/responder/回调路由/恢复路径各自回头调 sweeper：那四处都在改台账状态，
 * 让「什么时候催办」这件事有第二个真相源就会漂移。观察者不等（§3.7 的 3 秒义务在同一进程里）。
 */
export function installApprovalSweeper(ctx: Context, options: InstallSweeperOptions): () => void {
  const alarms = createScheduleAlarms(ctx)
  const sweeper = createApprovalSweeper({ ...options, alarms })
  const at = options.now ?? (() => Date.now())

  const releaseLedger = options.ledger.onChanged(record => {
    switch (record.status) {
      case 'pending':
        return void sweeper.arm(record)
      // 批准了：催办就此停止。作废留不留取决于**这条批准有没有落下批件**（`ledger.approve`
      // 让通知排在批件落账之后，所以这里读得到）：有批件 = 可能永远等不到重放，§3.5 的安全阀
      // 必须留着到点收回它；没批件 = 同步窗口内已经执行完，留着只是白挂一条幽灵自动化，
      // 且到点会误作废这条已完成的批准（#38）。
      case 'approved':
        return void sweeper.settle(record.requestId, options.ledger.hasOutstandingGrant(record.requestId))
      default:
        // 超窗转后台也走 `expired`，而那条批准还开着 —— 撤销它的告警就等于没人再催、
        // 到点也没人作废（§8 第 7 步在真进程里实测到的失效）。还在等人批的记录一律不动。
        if (isDecidable(record, at())) return
        return void sweeper.settle(record.requestId)
    }
  })

  // `schedule/changed` 在任何任务变更（含投递提交）后发出；我们只在里面找"已投递而未认领"的行。
  const releaseSchedule = ctx.on('schedule/changed', () => {
    void alarms.drain(sweeper).catch(error => ctx.logger.warn(`approval sweeper: drain failed: ${String(error)}`))
  })

  void sweeper.scanOpen()

  return () => {
    releaseLedger()
    releaseSchedule()
  }
}
