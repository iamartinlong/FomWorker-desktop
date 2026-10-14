/**
 * M1 催办与过期的验收单测（设计 §3.5、§8 第 6 步，含 E2 与 E14）。
 *
 * 决策核跑在**假告警端口**上：内核 `schedule` 的 `at` 只接受严格未来的时刻，
 * 「已经过期了才补登记」这条分支在真定时器上永远跑不到。真 `schedule` 的那两用例排在最后，
 * 它们要验的恰恰只有真组合能给的东西 —— job id 由内核生成、投递回执读得到、`catalog()` 认领得动。
 *
 * 时间源在这组用例里是假的（同步窗口那组必须真，见 `responder.spec.ts`）：催办与作废判定的是
 * 「相对时刻到没到」，不是「真定时器响没响」，把这两件事分开才能让 E14 的双请求跑在毫秒里。
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  createApprovalSweeper,
  createScheduleAlarms,
  defaultRemindAfterMs,
  installApprovalSweeper,
  sweepIdOf,
  type SweeperAlarms,
  type SweeperFailure,
  type SweeperTargets,
} from './sweeper.ts'
import type { ApprovalLedger, ApprovalRequestRecord, SweepKind, SweepRecord } from './ledger.ts'
import { argsDigest } from './ledger.ts'
import { boot, sleep, until, type Harness } from './test-harness.ts'

function pendingRecord(overrides: Partial<ApprovalRequestRecord> & { requestId: string }): ApprovalRequestRecord {
  const askedAt = overrides.askedAt ?? 1_000
  return {
    sessionId: 'session-1',
    tenantId: 'tenant-1',
    toolName: 'write',
    riskLevel: 'L3',
    actionSummary: '写入 C:\\Users\\demo\\report.docx',
    toolArgs: { file_path: 'C:\\Users\\demo\\report.docx', content: 'hello' },
    displayReason: '要写到会话工作区之外，workspace-write 已拒。',
    status: 'pending',
    askedAt,
    windowEndsAt: askedAt + 90_000,
    expiresAt: askedAt + 4 * 60 * 60_000,
    decidedBy: null,
    decidedAt: null,
    ...overrides,
  }
}

interface ArmInput {
  sessionId: string
  requestId: string
  kind: SweepKind
  at: number
  title: string
  prompt: string
}

/** 假告警端口：记住每一次武装与撤销，并可按需让撤销失败。 */
function fakeAlarms(options: { failArm?: boolean; failCancel?: boolean } = {}): SweeperAlarms & {
  armed: Map<string, ArmInput>
  cancelled: string[]
} {
  const armed = new Map<string, ArmInput>()
  const cancelled: string[] = []
  let seq = 0
  return {
    armed,
    cancelled,
    async arm(input) {
      if (options.failArm === true) throw new Error('alarm backend is down')
      armed.set(`alarm-${String(++seq)}`, input)
      return `alarm-${String(seq)}`
    },
    async cancel(alarmId) {
      if (options.failCancel === true) throw new Error('alarm backend refuses to cancel')
      if (!armed.delete(alarmId)) throw new Error(`unknown alarm ${alarmId}`)
      cancelled.push(alarmId)
    },
  }
}

function fakeTargets(): SweeperTargets & { reminded: string[]; expired: string[]; failRemind?: Error } {
  const reminded: string[] = []
  const expired: string[] = []
  return {
    reminded,
    expired,
    async remind(record) {
      if (this.failRemind !== undefined) throw this.failRemind
      reminded.push(record.requestId)
    },
    async expire(record) { expired.push(record.requestId) },
  }
}

function core(ledger: ApprovalLedger, options: {
  alarms: SweeperAlarms
  targets: SweeperTargets
  now?: () => number
  remindAfterMs?: number
}) {
  const failures: SweeperFailure[] = []
  return {
    failures,
    sweeper: createApprovalSweeper({
      ledger,
      alarms: options.alarms,
      targets: options.targets,
      now: options.now,
      remindAfterMs: options.remindAfterMs,
      onFailure: event => { failures.push(event) },
    }),
  }
}

const at = (harness: Harness, requestId: string, kind: SweepKind): SweepRecord | undefined =>
  harness.ledger.sweep(sweepIdOf(requestId, kind))

describe('武装（§3.5）', () => {
  it('一条 pending 审批登记两个时刻：催办在 askedAt+30min，作废在 expiresAt', async () => {
    const harness = await boot()
    const alarms = fakeAlarms()
    const { sweeper } = core(harness.ledger, { alarms, targets: fakeTargets(), now: () => 0 })
    await harness.ledger.create(pendingRecord({ requestId: 'req-1', askedAt: 1_000, expiresAt: 9_000 }))
    await sweeper.arm(harness.ledger.get('req-1')!)

    expect([...alarms.armed.values()].map(row => `${row.kind}@${String(row.at)}`)).toEqual([
      `remind@${String(1_000 + defaultRemindAfterMs)}`,
      'expire@9000',
    ])
    expect(alarms.armed.get('alarm-1')?.title).toBe('审批催办 · 写入 C:\\Users\\demo\\report.docx')
    // job id 回填到登记行：重启之后仍然知道该撤哪一个。
    expect(at(harness, 'req-1', 'remind')?.alarmId).toBe('alarm-1')
    expect(at(harness, 'req-1', 'expire')?.status).toBe('armed')
  })

  it('正文让模型别把催办当成新指令，也别替审批人批准', async () => {
    const harness = await boot()
    const alarms = fakeAlarms()
    const { sweeper } = core(harness.ledger, { alarms, targets: fakeTargets(), now: () => 0 })
    await harness.ledger.create(pendingRecord({ requestId: 'req-1' }))
    await sweeper.arm(harness.ledger.get('req-1')!)

    const remind = alarms.armed.get('alarm-1')!.prompt
    const expire = alarms.armed.get('alarm-2')!.prompt
    expect(remind).toContain('这不是新的用户指令')
    expect(remind).toContain('不要代替审批人批准')
    expect(remind).toContain('req-1')
    expect(expire).toContain('因未获批准已作废')
    // 内核限 120 字：超长的动作描述必须在标题里被夹掉，而不是让 create() 抛。
    const long = pendingRecord({ requestId: 'req-2', actionSummary: 'x'.repeat(300) })
    await harness.ledger.create(long)
    await sweeper.arm(long)
    expect(alarms.armed.get('alarm-3')!.title.length).toBeLessThanOrEqual(120)
  })

  it('重复 arm 不再武装第二个（schedule 没有幂等键，多武装的唯一后果是多一条打扰）', async () => {
    const harness = await boot()
    const alarms = fakeAlarms()
    const { sweeper } = core(harness.ledger, { alarms, targets: fakeTargets(), now: () => 0 })
    await harness.ledger.create(pendingRecord({ requestId: 'req-1' }))
    const record = harness.ledger.get('req-1')!
    await sweeper.arm(record)
    await sweeper.arm(record)

    expect(alarms.armed.size).toBe(2)
  })

  it('非 pending 不武装：批完的、拒掉的都不该再被催', async () => {
    const harness = await boot()
    const alarms = fakeAlarms()
    const { sweeper } = core(harness.ledger, { alarms, targets: fakeTargets(), now: () => 0 })
    for (const [requestId, status] of [['req-1', 'approved'], ['req-2', 'rejected']] as const) {
      await harness.ledger.create(pendingRecord({ requestId, status }))
      await sweeper.arm(harness.ledger.get(requestId)!)
    }
    expect(alarms.armed.size).toBe(0)
  })

  it('时刻已经过去（重启后补登记）：当场把该做的事做掉，不去落一个必然被内核拒绝的未来时刻', async () => {
    const harness = await boot()
    const alarms = fakeAlarms()
    const targets = fakeTargets()
    const { sweeper } = core(harness.ledger, { alarms, targets, now: () => 500_000, remindAfterMs: 100 })
    await harness.ledger.create(pendingRecord({ requestId: 'req-1', askedAt: 1_000, expiresAt: 2_000 }))

    await sweeper.arm(harness.ledger.get('req-1')!)

    // 有效期早在重启之前就过了：催办这条路直接撤销 —— 催一条批不动的审批只是打扰，
    // 而审批人点开只会得到一个「已过期」的失败回执。作废照做，收摊不受影响。
    expect(alarms.armed.size).toBe(0)
    expect(targets.reminded).toEqual([])
    expect(targets.expired).toEqual(['req-1'])
    expect(harness.ledger.get('req-1')!.status).toBe('expired')
    expect(at(harness, 'req-1', 'remind')?.status).toBe('cancelled')
    expect(at(harness, 'req-1', 'expire')?.status).toBe('fired')
  })

  it('告警层挂了：登记行删掉而不是留一行 armed 的空壳，下一次扫描还能重试', async () => {
    const harness = await boot()
    const alarms = fakeAlarms({ failArm: true })
    const { sweeper, failures } = core(harness.ledger, { alarms, targets: fakeTargets(), now: () => 0 })
    const record = pendingRecord({ requestId: 'req-1' })
    await harness.ledger.create(record)
    await sweeper.arm(record)

    expect(failures.map(failure => failure.stage)).toEqual(['arm', 'arm'])
    // 活性故障不伪装成已登记：行不存在，重启扫描才会重新试过。
    expect(at(harness, 'req-1', 'remind')).toBeUndefined()
    expect(at(harness, 'req-1', 'expire')).toBeUndefined()
  })

  it('已经登记过但没拿到 job id 的行不影响后续：attachAlarm 之后 armedAlarmIds 才认它', async () => {
    const harness = await boot()
    const alarms = fakeAlarms()
    const { sweeper } = core(harness.ledger, { alarms, targets: fakeTargets(), now: () => 0 })
    await harness.ledger.create(pendingRecord({ requestId: 'req-1' }))
    await sweeper.arm(harness.ledger.get('req-1')!)

    expect([...sweeper.armedAlarmIds().entries()]).toEqual([
      ['alarm-1', 'req-1_remind'],
      ['alarm-2', 'req-1_expire'],
    ])
  })
})

describe('到期动作（E4 的定时器版本）', () => {
  it('催办只在还在等的时候动手；同一告警交两次只重推一次', async () => {
    const harness = await boot()
    const alarms = fakeAlarms()
    const targets = fakeTargets()
    const { sweeper } = core(harness.ledger, { alarms, targets, now: () => 0 })
    await harness.ledger.create(pendingRecord({ requestId: 'req-1' }))
    await sweeper.arm(harness.ledger.get('req-1')!)

    expect(await sweeper.fire('req-1_remind')).toBe('reminded')
    // 至少一次投递：崩溃重投、或对账扫到两次，都不该产生第二次打扰。
    expect(await sweeper.fire('req-1_remind')).toBe('skipped')
    expect(targets.reminded).toEqual(['req-1'])

    const row = at(harness, 'req-1', 'remind')!
    expect(row.status).toBe('fired')
    // 已经 fired 的行不回滚成 armed：那是"催过办"这条审计本身。
    expect(await sweeper.fire('req-1_remind')).toBe('skipped')
  })

  it('已决策的审批拿到催办投递：判为 skipped 并撤销，卡片不再重推', async () => {
    const harness = await boot()
    const alarms = fakeAlarms()
    const targets = fakeTargets()
    const { sweeper } = core(harness.ledger, { alarms, targets, now: () => 0 })
    await harness.ledger.create(pendingRecord({ requestId: 'req-1' }))
    await sweeper.arm(harness.ledger.get('req-1')!)
    await harness.ledger.transition('req-1', { from: ['pending'], to: 'rejected' })

    expect(await sweeper.fire('req-1_remind')).toBe('skipped')
    expect(targets.reminded).toEqual([])
    expect(at(harness, 'req-1', 'remind')?.status).toBe('cancelled')
    // 已经响过的 job 撤不掉（它投递完就转 inactive），这里撤的是台账行。
    expect(alarms.armed.size).toBe(2)
  })

  it('超窗转后台的记录：催办照催、到点作废照做（§8 第 7 步真进程实测到的失效）', async () => {
    // `expired` 是这条主路上**真正等人批**的状态：同步窗口没人答，卡片转后台。
    // 上一版把它当成「已经作废」，撤销了它的两个告警 —— 于是催办永不发生，到点也没人收摊，
    // 卡片就这么挂着，直到有人手滑点一次「已过期」的按钮。
    const harness = await boot()
    const alarms = fakeAlarms()
    const targets = fakeTargets()
    const { sweeper } = core(harness.ledger, { alarms, targets, now: () => 0 })
    await harness.ledger.create(pendingRecord({ requestId: 'req-bg', status: 'expired' }))

    await sweeper.arm(harness.ledger.get('req-bg')!)
    expect([...alarms.armed.values()].map(row => row.kind)).toEqual(['remind', 'expire'])

    expect(await sweeper.fire('req-bg_remind')).toBe('reminded')
    expect(targets.reminded).toEqual(['req-bg'])

    // 到点：状态本来就是 `expired`，没有可迁的（CAS 必输），但收摊那两样一样不能少。
    expect(await sweeper.fire('req-bg_expire')).toBe('expired')
    expect(harness.ledger.get('req-bg')!.status).toBe('expired')
    expect(targets.expired).toEqual(['req-bg'])
  })

  it('有效期已经过了的记录：不催一条批不动的审批，作废仍然执行', async () => {
    const harness = await boot()
    const alarms = fakeAlarms()
    const targets = fakeTargets()
    let clock = 0
    const { sweeper } = core(harness.ledger, { alarms, targets, now: () => clock, remindAfterMs: 100 })
    await harness.ledger.create(pendingRecord({ requestId: 'req-dead', status: 'expired', askedAt: 0, expiresAt: 500 }))
    await sweeper.arm(harness.ledger.get('req-dead')!)
    expect(alarms.armed.size).toBe(2)

    // 跨过有效期：告警到点，但催办这条路判的是「批准之门还开着吗」——门早就关了，不催。
    clock = 600
    expect(await sweeper.fire('req-dead_remind')).toBe('skipped')
    expect(targets.reminded).toEqual([])
    // 作废不看门开没开，只看还有没有终局：这一条欠一次收摊。
    expect(await sweeper.fire('req-dead_expire')).toBe('expired')
    expect(targets.expired).toEqual(['req-dead'])
  })

  it('重推失败报告 remind 阶段，不伪装成没发生过', async () => {
    const harness = await boot()
    const alarms = fakeAlarms()
    const targets = fakeTargets()
    targets.failRemind = new Error('im channel is down')
    const { sweeper, failures } = core(harness.ledger, { alarms, targets, now: () => 0 })
    await harness.ledger.create(pendingRecord({ requestId: 'req-1' }))
    await sweeper.arm(harness.ledger.get('req-1')!)

    expect(await sweeper.fire('req-1_remind')).toBe('skipped')
    expect(failures.map(failure => [failure.stage, failure.kind])).toEqual([['remind', 'remind']])
  })

  it('过期作废：落账 + 通知发起人，pending 与「批了但批件还在」的 approved 都作废', async () => {
    const harness = await boot()
    for (const status of ['pending', 'approved'] as const) {
      const alarms = fakeAlarms()
      const targets = fakeTargets()
      const { sweeper } = core(harness.ledger, { alarms, targets, now: () => 0 })
      const requestId = `req-${status}`
      await harness.ledger.create(pendingRecord({ requestId, status, decidedBy: status === 'pending' ? null : 'boss', decidedAt: status === 'pending' ? null : 2_000 }))
      await sweeper.arm({ ...harness.ledger.get(requestId)!, status: 'pending' })
      // `approved` 这条要带一张未消费的批件才该被作废 —— §3.5 留着作废的唯一理由就是收回它。
      if (status === 'approved') {
        await harness.ledger.grants.put('grant-expire-1', {
          grantId: 'grant-expire-1',
          requestId,
          toolName: 'write',
          argsDigest: 'digest',
          consumes: 1,
          grantedAt: 2_000,
          grantExpiresAt: 4_000,
        })
      }

      expect(await sweeper.fire(sweepIdOf(requestId, 'expire'))).toBe('expired')
      expect(harness.ledger.get(requestId)!.status).toBe('expired')
      expect(targets.expired).toEqual([requestId])
      // 作废把批件一并收回（pending 那条本来就没有，approved 那条从一张变零张）。
      expect([...harness.ledger.grants.keys()].filter(id => harness.ledger.grants.get(id)!.requestId === requestId)).toEqual([])
    }
  })

  it('#38 已批且批件已消失（窗口内批准 / 重放已消费）：到点不作废、就地撤销告警', async () => {
    const harness = await boot()
    const alarms = fakeAlarms()
    const targets = fakeTargets()
    const { sweeper } = core(harness.ledger, { alarms, targets, now: () => 0 })
    // 一条同步窗口内批准的记录：状态 approved、有 decidedBy，但**没有任何批件**（那一轮就执行完了）。
    await harness.ledger.create(pendingRecord({ requestId: 'req-done', status: 'approved', decidedBy: 'boss', decidedAt: 2_000 }))
    await harness.ledger.armSweep({
      sweepId: 'req-done_expire',
      requestId: 'req-done',
      kind: 'expire',
      at: 9_000,
      alarmId: 'alarm-done',
      status: 'armed',
      armedAt: 0,
      firedAt: null,
    })

    // 到点不能把它改写成 expired、也不能给发起人发「因未获批准，任务未完成」—— 它其实批了也做了。
    expect(await sweeper.fire('req-done_expire')).toBe('skipped')
    expect(harness.ledger.get('req-done')!.status).toBe('approved')
    expect(targets.expired).toEqual([])
    expect(at(harness, 'req-done', 'expire')?.status).toBe('cancelled')
  })

  it('作废同时收回没被重放消费掉的批件（§3.5「过期 ⇒ grants 不再受理」）', async () => {
    const harness = await boot()
    const alarms = fakeAlarms()
    const targets = fakeTargets()
    const { sweeper } = core(harness.ledger, { alarms, targets, now: () => 0 })
    const record = pendingRecord({ requestId: 'req-1' })
    await harness.ledger.create(record)
    const digest = argsDigest(record.toolArgs as Record<string, unknown>)
    await harness.ledger.approve('req-1', {
      decidedBy: 'boss',
      now: 2_000,
      grant: { grantId: 'grant-1', toolName: 'write', argsDigest: digest, grantExpiresAt: record.expiresAt },
    })
    await sweeper.scanOpen()

    expect(await sweeper.fire('req-1_expire')).toBe('expired')
    expect([...harness.ledger.grants.keys()]).toEqual([])
    // 批件被收回之后，同工具同参数的重放拿不到授权 —— 这就是过期是安全阀而不是提醒的理由。
    expect(await harness.ledger.consumeGrant('write', digest, 3_000)).toBeUndefined()
  })

  it('作废撞上一次刚刚发生的批准：CAS 输了就不再动手', async () => {
    const harness = await boot()
    const alarms = fakeAlarms()
    const targets = fakeTargets()
    const { sweeper } = core(harness.ledger, { alarms, targets, now: () => 0 })
    await harness.ledger.create(pendingRecord({ requestId: 'req-1' }))
    await sweeper.arm(harness.ledger.get('req-1')!)

    // 认领与迁移之间的那一步被另一条链抢先：responder 正好在这一刻批完了。
    const winning = harness.ledger.approve('req-1', {
      decidedBy: 'boss',
      now: 1_500,
      grant: { grantId: 'grant-1', toolName: 'write', argsDigest: 'digest', grantExpiresAt: 9_000 },
    })
    const fired = await sweeper.fire('req-1_expire')
    await winning

    expect(fired).toBe('expired')
    // 迁移集合含 approved，所以这一次作废仍然成立：批了但永远没重放的批件必须能死掉。
    expect(harness.ledger.get('req-1')!.status).toBe('expired')
    expect(targets.expired).toEqual(['req-1'])
  })

  it('已消费完的批件（consumed）不再作废：动作已经做完了', async () => {
    const harness = await boot()
    const alarms = fakeAlarms()
    const targets = fakeTargets()
    const { sweeper } = core(harness.ledger, { alarms, targets, now: () => 0 })
    await harness.ledger.create(pendingRecord({ requestId: 'req-1' }))
    await harness.ledger.transition('req-1', { from: ['pending'], to: 'consumed' })
    await harness.ledger.armSweep({
      sweepId: 'req-1_expire',
      requestId: 'req-1',
      kind: 'expire',
      at: 9_000,
      alarmId: 'alarm-9',
      status: 'armed',
      armedAt: 0,
      firedAt: null,
    })

    expect(await sweeper.fire('req-1_expire')).toBe('skipped')
    expect(targets.expired).toEqual([])
    expect(at(harness, 'req-1', 'expire')?.status).toBe('cancelled')
  })

  it('不存在的告警与不存在的审批：unknown，不动任何账', async () => {
    const harness = await boot()
    const targets = fakeTargets()
    const { sweeper } = core(harness.ledger, { alarms: fakeAlarms(), targets, now: () => 0 })

    expect(await sweeper.fire('nope_remind')).toBe('unknown')
    await harness.ledger.armSweep({
      sweepId: 'ghost_expire',
      requestId: 'ghost',
      kind: 'expire',
      at: 1,
      alarmId: 'alarm-1',
      status: 'armed',
      armedAt: 0,
      firedAt: null,
    })
    expect(await sweeper.fire('ghost_expire')).toBe('unknown')
    expect(targets.expired).toEqual([])
  })
})

describe('撤销与重启（E3 的告警半边）', () => {
  it('决策即撤销：rejected 撤两个，approved 只撤催办、留下作废', async () => {
    const harness = await boot()
    const alarms = fakeAlarms()
    const { sweeper } = core(harness.ledger, { alarms, targets: fakeTargets(), now: () => 0 })
    for (const requestId of ['req-rejected', 'req-approved']) {
      await harness.ledger.create(pendingRecord({ requestId }))
      await sweeper.arm(harness.ledger.get(requestId)!)
    }

    await sweeper.settle('req-rejected')
    expect(alarms.cancelled.sort()).toEqual(['alarm-1', 'alarm-2'])
    expect(harness.ledger.sweepsOf('req-rejected').map(row => row.status)).toEqual(['cancelled', 'cancelled'])

    await sweeper.settle('req-approved', true)
    expect(alarms.cancelled).toEqual(['alarm-1', 'alarm-2', 'alarm-3'])
    expect(harness.ledger.sweepsOf('req-approved').map(row => `${row.kind}:${row.status}`)).toEqual([
      'remind:cancelled',
      'expire:armed',
    ])
  })

  it('撤销失败只报告：行已经是 cancelled，残留 job 到点拿不到动作', async () => {
    const harness = await boot()
    const alarms = fakeAlarms({ failCancel: true })
    const { sweeper, failures } = core(harness.ledger, { alarms, targets: fakeTargets(), now: () => 0 })
    await harness.ledger.create(pendingRecord({ requestId: 'req-1' }))
    await sweeper.arm(harness.ledger.get('req-1')!)

    await sweeper.settle('req-1')
    expect(failures.map(failure => failure.stage)).toEqual(['cancel', 'cancel'])
    expect(harness.ledger.sweepsOf('req-1').map(row => row.status)).toEqual(['cancelled', 'cancelled'])
  })

  it('scanOpen 补登记：pending 补两个，超窗转后台的 expired 也补两个，approved 只在还挂着批件时补作废', async () => {
    const harness = await boot()
    const alarms = fakeAlarms()
    const { sweeper } = core(harness.ledger, { alarms, targets: fakeTargets(), now: () => 0 })
    await harness.ledger.create(pendingRecord({ requestId: 'req-pending' }))
    await harness.ledger.create(pendingRecord({ requestId: 'req-background', status: 'expired' }))
    await harness.ledger.create(pendingRecord({ requestId: 'req-approved', status: 'approved' }))
    // 这条是「窗口内批准、批件从没存在过」的记录：重启不该再给它挂出一条幽灵作废自动化（#38）。
    await harness.ledger.create(pendingRecord({ requestId: 'req-done', status: 'approved', decidedBy: 'boss' }))
    await harness.ledger.create(pendingRecord({ requestId: 'req-rejected', status: 'rejected' }))
    await harness.ledger.grants.put('grant-scan-1', {
      grantId: 'grant-scan-1',
      requestId: 'req-approved',
      toolName: 'write',
      argsDigest: 'digest',
      consumes: 1,
      grantedAt: 0,
      grantExpiresAt: 9_000,
    })

    // `req-done` 仍在 open 集合里（状态是 approved），但补登记只给有批件的那条落 expire job。
    expect(await sweeper.scanOpen()).toBe(4)
    expect([...alarms.armed.values()].map(row => `${row.requestId}_${row.kind}`)).toEqual([
      'req-pending_remind',
      'req-pending_expire',
      'req-background_remind',
      'req-background_expire',
      'req-approved_expire',
    ])

    // 第二次扫描（另一个进程的重启、或同一进程里的重复订阅）不产生第二个 job。
    expect(await sweeper.scanOpen()).toBe(4)
    expect(alarms.armed.size).toBe(5)
  })

  it('E14：两条 L3 询问各自两个告警，批掉一条不影响另一条', async () => {
    const harness = await boot()
    const alarms = fakeAlarms()
    const targets = fakeTargets()
    const { sweeper } = core(harness.ledger, { alarms, targets, now: () => 0 })
    for (const requestId of ['req-1', 'req-2']) {
      await harness.ledger.create(pendingRecord({ requestId, sessionId: 'session-shared' }))
    }
    await sweeper.scanOpen()
    expect(alarms.armed.size).toBe(4)

    await harness.ledger.approve('req-1', {
      decidedBy: 'boss',
      now: 2_000,
      grant: { grantId: 'grant-1', toolName: 'write', argsDigest: 'digest', grantExpiresAt: 9_000 },
    })
    await sweeper.settle('req-1', true)

    // 第二条审批还开着：它的催办与作废都还在，不能被邻居的决策带走。
    expect(harness.ledger.sweepsOf('req-2').map(row => row.status)).toEqual(['armed', 'armed'])
    expect(await sweeper.fire('req-2_remind')).toBe('reminded')
    expect(targets.reminded).toEqual(['req-2'])
  })
})

// 这一组跑的是真 `ctx.schedule` + 真定时器：8 个文件并行满载时，光 boot 与投递回执就能吃掉数秒，
// 默认的 5 秒用时会偶然超时（断言等的是台账里的事实，不是墙钟，所以放宽超时不会掩盖真故障）。
describe('真 ctx.schedule 集成', { timeout: 30_000 }, () => {
  it('武装的 job 由内核生成 id，到期后靠 catalog() 的回执被认领一次', async () => {
    const harness = await boot({ schedule: true })
    const alarms = createScheduleAlarms(harness.ctx)
    const targets = fakeTargets()
    const sweeper = createApprovalSweeper({ ledger: harness.ledger, alarms, targets, remindAfterMs: 300 })

    // 真定时器：催办排在这次调用的时序里，所以这一组不传假 now（同 §3.3 的纪律）。
    const record = pendingRecord({
      requestId: 'req-real',
      sessionId: harness.scheduleSessionId!,
      askedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    })
    await harness.ledger.create(record)
    await sweeper.arm(record)

    // 登记行先写（`alarmId: null`）、job 后建，所以「行在」不等于「武装完了」。
    // 台账上的观察者与本用例几乎同时在武装：观察者赢了 CAS 时，`arm()` 看到行已存在就直接返回，
    // 那一刻 `alarmId` 还是 null、`expire` 那条甚至还没轮到 —— 满载并行下这两次偶发红同源
    // （同上面那条用例的等待纪律：等的是台账里的事实，不是墙钟）。
    const armed = await untilAsync(async () => {
      const remind = harness.ledger.sweep('req-real_remind')
      const expire = harness.ledger.sweep('req-real_expire')
      if (remind === undefined || expire === undefined) return undefined
      if (remind.alarmId === null || expire.alarmId === null) return undefined
      return { remind, expire }
    }, '两个告警没把 job id 回填到登记行')
    // job id 是内核生成的（`schedule-<uuid>`），不是我们的编号 —— 对照表只能自己记。
    expect(typeof armed.remind.alarmId, `登记行：${JSON.stringify(armed.remind)}`).toBe('string')
    expect(armed.remind.alarmId).toMatch(/^schedule-[0-9a-f-]{36}$/)
    const sessionId = SessionId(record.sessionId)
    // 不按条数按 id 认：催办排在 300ms，满载下它可能已经投递完成并从 active 集合里消失
    // —— 那是投递成功，不是漏挂。这一条要钉的是「未来那条一定还在」与「每个 kind 至多一个 job
    // （没有重复武装）」，两者都和墙钟无关。
    const activeIds = (await harness.ctx.schedule.list({ sessionId })).map(job => String(job.id))
    expect(activeIds).toContain(String(armed.expire.alarmId))
    expect(new Set(activeIds).size).toBe(activeIds.length)

    // 投递的唯一形态是给会话发一条用户消息：平台侧不解析它，只等回执。
    await until(() => harness.delivered.length >= 1, '真 schedule 没投递')
    expect(harness.delivered[0]!.source).toBe('schedule')
    expect(harness.delivered[0]!.text).toContain('req-real')
    expect(await drainUntilHandled(alarms, sweeper)).toBe(1)

    expect(targets.reminded).toEqual(['req-real'])
    expect(harness.ledger.sweep('req-real_remind')!.status).toBe('fired')
    // 认领之后同一个回执再扫一次：不重复动作（至少一次投递的另一半）。
    expect(await alarms.drain(sweeper)).toBe(0)
    expect(targets.reminded).toEqual(['req-real'])

    // 已投递并落回执的一次性任务从 active 集合里消失，作废那条还留着。
    expect(await harness.ctx.schedule.list({ sessionId })).toHaveLength(1)
    const catalog = await harness.ctx.schedule.catalog()
    expect(catalog.filter(entry => entry.lastDelivery !== undefined)).toHaveLength(1)
  })

  it('对账只认投递回执：还在武装而未投递的 job 不动，别人家的 job 更不认领', async () => {
    const harness = await boot({ schedule: true })
    const alarms = createScheduleAlarms(harness.ctx)
    const targets = fakeTargets()
    // 这一条不等我们的定时器：催办与作废都排在一分钟之后，只有别人的 job 会到点。
    const sweeper = createApprovalSweeper({ ledger: harness.ledger, alarms, targets, remindAfterMs: 60_000 })
    const sessionId = SessionId(harness.scheduleSessionId!)

    await harness.ledger.create(pendingRecord({
      requestId: 'req-wait',
      sessionId: harness.scheduleSessionId!,
      askedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    }))
    await sweeper.arm(harness.ledger.get('req-wait')!)
    // `catalog()` 是全域的：同一会话里用户自己的定时任务也在里面，投递了也不归我们认领。
    const foreign = await harness.ctx.schedule.create(sessionId, {
      title: '用户的日报', prompt: '该写日报了', at: new Date(Date.now() + 300).toISOString(),
    })

    await until(() => harness.delivered.length >= 1, '别人家的 job 没投递')
    expect(harness.delivered[0]!.text).toContain('日报')
    // 消息送出去与回执落盘之间隔着内核自己的写链：等到回执真在 catalog 里，才谈得上「它被扫到过」。
    await untilAsync(async () => {
      const entries = await harness.ctx.schedule.catalog()
      const settled = entries.some(entry => String(entry.id) === String(foreign.id) && entry.lastDelivery !== undefined)
      return settled ? true : undefined
    }, '别人家的 job 回执没落进 catalog')
    // 我们的两个 job 还活着、还没投递，别人的有回执但不在对照表里 —— 两边都不该动手。
    expect(await alarms.drain(sweeper)).toBe(0)
    expect(targets.reminded).toEqual([])
    expect(harness.ledger.sweep('req-wait_remind')!.status).toBe('armed')
    expect(harness.ledger.sweep('req-wait_expire')!.status).toBe('armed')
  })

  it('installApprovalSweeper：台账走到哪一步，告警就武装或撤销到哪一步', async () => {
    const harness = await boot({ schedule: true })
    const targets = fakeTargets()
    const failures: SweeperFailure[] = []
    // 这一条验的是挂载与撤销，不等定时器，所以催办排在一分钟之后。
    const release = installSweeper(harness.ctx, harness.ledger, targets, failures, 60_000)
    const sessionId = SessionId(harness.scheduleSessionId!)

    // 挂载时账上没有开着的审批。
    expect(await harness.ctx.schedule.list({ sessionId })).toHaveLength(0)

    await harness.ledger.create(pendingRecord({
      requestId: 'req-window',
      sessionId: harness.scheduleSessionId!,
      askedAt: Date.now(),
      windowEndsAt: Date.now() + 90_000,
      expiresAt: Date.now() + 60_000,
    }))
    // 登记行先写、job 后建，所以"两个 job 都在"要等到两条行都回填了 alarmId 才算数。
    await until(() => {
      const remind = harness.ledger.sweep('req-window_remind')
      const expire = harness.ledger.sweep('req-window_expire')
      return remind !== undefined && remind.alarmId !== null && expire !== undefined && expire.alarmId !== null
    }, '挂到台账上的观察者没把两个告警都武装上')
    expect(await harness.ctx.schedule.list({ sessionId })).toHaveLength(2)

    // 同窗口内批准：催办就此停止，作废仍然留着（批件可能在等一次永远不会来的重放）。
    await harness.ledger.approve('req-window', {
      decidedBy: 'boss',
      now: Date.now(),
      grant: { grantId: 'grant-1', toolName: 'write', argsDigest: 'digest', grantExpiresAt: Date.now() + 60_000 },
    })
    await until(() => harness.ledger.sweep('req-window_remind')!.status === 'cancelled', '批准没撤掉催办')
    // 撤完催办不等于撤完：`settle` 还在往下走。等它不再变化，才读得到「作废被保留」这个终态。
    await quiesce(() => harness.ledger.sweepsOf('req-window').map(row => `${row.kind}:${row.status}`).join(','))
    expect(harness.ledger.sweep('req-window_expire')!.status).toBe('armed')
    // 登记行先标 cancelled、job 后删：中间那一刻 `list` 还看得见两个，所以这里等到只剩一个。
    expect(await untilAsync(async () => {
      const active = await harness.ctx.schedule.list({ sessionId })
      return active.length === 1 ? active : undefined
    }, '催办的 job 没被删掉')).toHaveLength(1)
    expect(failures).toEqual([])

    release()
  })

  it('#38 挂载：窗口内批准（无批件）当场撤掉作废，侧栏不留幽灵自动化', async () => {
    const harness = await boot({ schedule: true })
    const targets = fakeTargets()
    const failures: SweeperFailure[] = []
    const release = installSweeper(harness.ctx, harness.ledger, targets, failures, 60_000)
    const sessionId = SessionId(harness.scheduleSessionId!)

    await harness.ledger.create(pendingRecord({
      requestId: 'req-inwindow',
      sessionId: harness.scheduleSessionId!,
      askedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    }))
    await until(() => {
      const remind = harness.ledger.sweep('req-inwindow_remind')
      const expire = harness.ledger.sweep('req-inwindow_expire')
      return remind?.alarmId != null && expire?.alarmId != null
    }, '两个告警没武装上')
    expect(await harness.ctx.schedule.list({ sessionId })).toHaveLength(2)

    // 同步窗口内的批准走的是 `transition`（不是 `ledger.approve`）：那一轮就执行完，从不落批件。
    // 观察者的判定是「approved 且没有批件 ⇒ 没有东西要收回」，于是催办与作废一起撤。
    expect(await harness.ledger.transition('req-inwindow', { from: ['pending'], to: 'approved', set: { decidedBy: 'boss', decidedAt: Date.now() } })).toBe(true)
    await quiesce(() => harness.ledger.sweepsOf('req-inwindow').map(row => `${row.kind}:${row.status}`).join(','))
    expect(harness.ledger.sweepsOf('req-inwindow').map(row => `${row.kind}:${row.status}`)).toEqual(['remind:cancelled', 'expire:cancelled'])

    // 侧栏的「1 个自动化任务」来自内核 catalog 里那条还活着的 job：批准之后必须归零。
    expect(await untilAsync(async () => {
      const active = await harness.ctx.schedule.list({ sessionId })
      return active.length === 0 ? active : undefined
    }, '批准后作废告警没被删掉（幽灵自动化）')).toHaveLength(0)
    expect(failures).toEqual([])

    release()
  })

  it('installApprovalSweeper：同步窗口超期转后台不动告警，催办到点真的投递进会话（F-A）', async () => {
    const harness = await boot({ schedule: true })
    const targets = fakeTargets()
    const failures: SweeperFailure[] = []
    // 催办排在 300ms：这一条验的就是真投递，认领靠挂载自己订阅的 `schedule/changed`，不由用例代劳。
    const release = installSweeper(harness.ctx, harness.ledger, targets, failures, 300)
    const sessionId = SessionId(harness.scheduleSessionId!)

    await harness.ledger.create(pendingRecord({
      requestId: 'req-bg',
      sessionId: harness.scheduleSessionId!,
      askedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    }))
    await until(() => {
      const remind = harness.ledger.sweep('req-bg_remind')
      const expire = harness.ledger.sweep('req-bg_expire')
      return remind !== undefined && remind.alarmId !== null && expire !== undefined && expire.alarmId !== null
    }, '两个告警没武装上')

    // 同步窗口没人答：responder 把记录写成 `expired`。这**不是**决策，只是转后台。
    // 断言按 F-A 的主张写，不按时刻写：这一条要钉的是「转后台既没撤掉任何告警、也没换掉挂出去的
    // job」，而不是「检查的那一刻催办还没到点」—— 后者在 8 个文件并行满载时会偶然红（催办排在
    // 300ms，而中间的轮询本身就可能吃掉 300ms）。`fired` 是到点了，不是被这次 transition 动了。
    const armedBefore = harness.ledger.sweepsOf('req-bg').map(row => `${row.kind}:${row.alarmId}`)
    expect(await harness.ledger.transition('req-bg', { from: ['pending'], to: 'expired' })).toBe(true)
    // 等挂载那一侧不再动笔，再读终态：否则「撤掉告警」的 bug 会因为读在两次撤销之间而漏网。
    await quiesce(() => harness.ledger.sweepsOf('req-bg').map(row => `${row.kind}:${row.status}`).join(','))
    const rowsAfter = harness.ledger.sweepsOf('req-bg')
    expect(rowsAfter.map(row => `${row.kind}:${row.alarmId}`)).toEqual(armedBefore)
    // 被撤掉（F-A 的那个 bug）才是这条主张的反例。
    expect(rowsAfter.filter(row => row.status === 'cancelled')).toEqual([])
    // 转后台没删掉任何 job：作废那条一定还在（它排在 60 秒之后），催办那条要么还在、要么已经
    // 投递完成并离开 active 集合 —— 按 id 认才与墙钟无关；id 不重复挡住「重复武装」。
    const activeAfterTransition = (await harness.ctx.schedule.list({ sessionId })).map(job => String(job.id))
    expect(activeAfterTransition).toContain(String(rowsAfter.find(row => row.kind === 'expire')!.alarmId))
    expect(new Set(activeAfterTransition).size).toBe(activeAfterTransition.length)

    // 催办照旧到点：转后台的那条主路径本来就是等人批，不催就再也没人记得它。
    await until(() => targets.reminded.length === 1, '转后台的审批没被催办')
    expect(harness.delivered[0]!.text).toContain('req-bg')
    expect(harness.delivered[0]!.source).toBe('schedule')
    expect(harness.ledger.sweep('req-bg_expire')!.status).toBe('armed')
    expect(failures).toEqual([])

    release()
  })
})

/**
 * 等到某个签名字**连续一段时间不再变化**，然后才读终态。
 *
 * 存在的理由：挂载里的 `settle` 是 `void`（不 await），它按行序逐条撤，每两条之间隔着一次
 * json 落盘。用例若在「撤完第一条」那一刻读，就会把「批准时连作废一起撤」这类 bug 看成正常
 * —— 变异检验里这条改坏正是这样活下来的。等它不再变化，读到的才是这次决策的终态。
 */
async function quiesce(probe: () => string, stableMs = 200, budgetMs = 4_000): Promise<string> {
  const deadline = Date.now() + budgetMs
  let last = probe()
  let stableFor = 0
  while (stableFor < stableMs && Date.now() < deadline) {
    await sleep(20)
    const next = probe()
    stableFor = next === last ? stableFor + 20 : 0
    last = next
  }
  return last
}

/**
 * 轮询一个异步判据直到它给出值。
 *
 * 生产不等：内核在提交之后发 `schedule/changed`，投递回执与 job 删除都是事件叫醒的。
 * 用例里没有那条事件链（或只想读"最终有几个"），只能轮询 —— 投递（`followup`）与回执落盘、
 * 标 cancelled 与删 job 之间都隔着内核自己的写链，立刻读会读到中间那一刻。
 */
async function untilAsync<T>(probe: () => Promise<T | undefined>, message: string): Promise<T> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(message)
    await sleep(20)
  }
}

/** 等到投递回执出现在 `catalog()` 里并被认领。 */
async function drainUntilHandled(alarms: ReturnType<typeof createScheduleAlarms>, sweeper: ReturnType<typeof createApprovalSweeper>): Promise<number> {
  return await untilAsync(async () => {
    const handled = await alarms.drain(sweeper)
    return handled > 0 ? handled : undefined
  }, '投递回执始终没出现在 catalog 里')
}

/** 挂真 sweeper：与产品的入口同一个，只是把催办时长与失败去处交给用例。 */
function installSweeper(ctx: Context, ledger: ApprovalLedger, targets: SweeperTargets, failures: SweeperFailure[], remindAfterMs: number): () => void {
  return installApprovalSweeper(ctx, {
    ledger,
    targets,
    remindAfterMs,
    onFailure: event => { failures.push(event) },
  })
}
