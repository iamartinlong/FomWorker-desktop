/**
 * M1 同步窗口裁决者的验收单测（设计 §8 第 3 步：E1 / E7 / E13，外加 §3.4.1③ 的 grants 支路）。
 *
 * 卡片渠道用终端模拟实现（第 6 步才换飞书），其余全真：真注册表、真审批服务、真 json 台账、
 * 真定时器 —— 同步窗口是唯一会被假时钟掩盖的东西，所以这组用例不传 `gateNow`。
 */

import { describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type { ApprovalCard, ApprovalChannel, ApprovalClick } from './responder.ts'
import { installApprovalResponder } from './responder.ts'
import { argsDigest, type ApprovalLedger, type ApprovalRequestRecord } from './ledger.ts'
import { boot, call, escalated, execute, fakeAgent, newRoot, rejectingBackend } from './test-harness.ts'

class TerminalCard implements ApprovalCard {
  readonly cardId: string
  private settled = false
  private resolver: ((click: ApprovalClick | undefined) => void) | undefined
  private readonly pending: Promise<ApprovalClick | undefined>

  constructor(cardId: string, signal: AbortSignal) {
    this.cardId = cardId
    this.pending = new Promise(resolve => { this.resolver = resolve })
    // 内核 race 到 cancelled 之后不会通知监听器，所以卡片必须自己观察 signal（§3.3）
    signal.addEventListener('abort', () => this.settle(undefined), { once: true })
  }

  waitForClick(): Promise<ApprovalClick | undefined> {
    return this.pending
  }

  /** 测试侧的一次真实点击。 */
  click(decision: ApprovalClick['decision'], openId: string): void {
    this.settle({ decision, openId })
  }

  private settle(click: ApprovalClick | undefined): void {
    if (this.settled) return
    this.settled = true
    this.resolver?.(click)
  }
}

interface FakeChannel {
  channel: ApprovalChannel
  sent: { record: ApprovalRequestRecord; card: TerminalCard }[]
  updates: string[]
  deferred: string[]
  recalls: string[]
}

function fakeChannel(options: { down?: boolean; onSend?: () => void } = {}): FakeChannel {
  const sent: FakeChannel['sent'] = []
  const updates: string[] = []
  const deferred: string[] = []
  const recalls: string[] = []
  return {
    sent,
    updates,
    deferred,
    recalls,
    channel: {
      send: async (record, signal) => {
        options.onSend?.()
        if (options.down === true) throw new Error('im channel is down')
        const card = new TerminalCard(`card-${sent.length + 1}`, signal)
        sent.push({ record, card })
        return card
      },
      update: async (_card, text) => { updates.push(text) },
      defer: async (_card, text) => { deferred.push(text) },
      recall: async (_card, text) => { recalls.push(text) },
    },
  }
}

function responderOf(cards: FakeChannel) {
  return (ctx: Context, ledger: ApprovalLedger) => {
    installApprovalResponder(ctx, { ledger, channel: cards.channel })
  }
}

/** 卡片是异步发出的，等到第 N 张卡出现再继续（不用固定 sleep，避免 CI 抖动）。 */
async function until(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the approval card')
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

describe('responder：同步窗口内的裁决（E1）', () => {
  it('窗口内点「同意」→ allowed-once、记录迁 approved、卡片就地更新、不落 grant', async () => {
    const cards = fakeChannel()
    const setup = await boot({ windowMs: 5_000, answer: responderOf(cards) })
    const pending = execute(setup.ctx, call('write', escalated))
    await until(() => cards.sent.length === 1)

    expect(cards.sent[0]!.record).toMatchObject({ toolName: 'write', riskLevel: 'L3', actionSummary: '写入 C:\\Users\\demo\\report.docx' })
    cards.sent[0]!.card.click('approve', 'ou-alice')

    expect((await pending).isError).toBe(false)
    expect(setup.calls.write).toHaveLength(1)
    const record = setup.ledger.get('req-gate-1')!
    expect(record.status).toBe('approved')
    expect(record.decidedBy).toBe('ou-alice')
    expect(record.decidedAt).toBeTypeOf('number')
    expect(cards.updates).toEqual(['已由 ou-alice 批准'])
    expect(cards.recalls).toEqual([])
    // 同窗口已放行：这一轮就执行了，不需要给未来的重放留授权（§3.3）
    expect([...setup.ledger.grants.keys()]).toEqual([])
  })

  it('窗口内点「拒绝」→ rejected，模型看到的是"用户拒绝"而不是"没人答"', async () => {
    const cards = fakeChannel()
    const setup = await boot({ windowMs: 5_000, answer: responderOf(cards) })
    const pending = execute(setup.ctx, call('write', escalated))
    await until(() => cards.sent.length === 1)
    cards.sent[0]!.card.click('reject', 'ou-bob')

    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: 'Error: the user rejected tool "write"' })
    expect(setup.calls.write).toHaveLength(0)
    expect(setup.ledger.get('req-gate-1')!.status).toBe('rejected')
    expect(cards.updates).toEqual(['已由 ou-bob 拒绝'])
  })

  it('窗口到期 → cancelled（不是 rejected）、记录迁 expired、卡片就地转后台且**不撤回**', async () => {
    const cards = fakeChannel()
    const setup = await boot({ windowMs: 20, answer: responderOf(cards) })
    const result = await execute(setup.ctx, call('write', escalated))

    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: 'Error: approval for tool "write" was cancelled' })
    expect(setup.calls.write).toHaveLength(0)
    expect(setup.ledger.get('req-gate-1')!.status).toBe('expired')
    expect(setup.ledger.get('req-gate-1')!.decidedBy).toBeNull()
    // F-E：`expired` 仍在 `isDecidable` 里（路由照收迟到批准、催办还会为它推卡），
    // 而真渠道的 recall 是 DELETE —— 撤了就没有任何入口能把这条批下来。
    expect(cards.deferred).toEqual(['同步窗口内没人应答，已转后台等待审批'])
    expect(cards.recalls).toEqual([])
    expect(cards.updates).toEqual([])
  })

  it('门已经关上（`expiresAt` 早于窗口结束）时才真的撤卡', async () => {
    const cards = fakeChannel()
    // 安全阀比同步窗口还短：到期那一刻 `isDecidable` 已经是 false，这张卡点 also 没用，
    // 留在会话里只会诱导审批人反复点（§3.6 的点击洪峰），所以这一支才走 DELETE。
    const setup = await boot({ windowMs: 40, expiresMs: { L3: 5 }, answer: responderOf(cards) })
    await execute(setup.ctx, call('write', escalated))

    expect(setup.ledger.get('req-gate-1')!.status).toBe('expired')
    expect(cards.recalls).toEqual(['本次询问已作废'])
    expect(cards.deferred).toEqual([])
  })
})

describe('responder：取消与渠道故障（E7 / E13）', () => {
  it('E7 调用方取消（session.cancel 的等价信号）→ recalled + 卡片转后台 + cancelled', async () => {
    const cards = fakeChannel()
    const setup = await boot({ windowMs: 5_000, answer: responderOf(cards) })
    const target = call('write', escalated)
    const pending = execute(setup.ctx, target)
    await until(() => cards.sent.length === 1)

    target.controller.abort('user closed the page')
    const result = await pending

    expect(result.isError).toBe(true)
    // 调用方自己取消时，模型看到的是内核的规范中止文案，不是「审批被作废」。
    // 内核在 `serviceAsk` 之后拿 `callerCancelled && approvalCancelled` 覆盖了 deny 文案
    // （`core/tools/src/index.ts:1513`）—— 区分「用户主动中止」和「没人答」这件事，
    // 是内核做的，不是我们文案里加的。窗口到期那条路径才是 cancelled 文案（见上一个用例）。
    expect(result.content[0]).toMatchObject({ text: 'Error: tool call aborted before dispatch' })
    // 内核 race 到 cancelled 就立刻把结局交回调用方，我们的收尾（迁状态 + 撤回卡片）
    // 是在它之后自己跑完的 —— 模型下一步可能已经开始了。所以收尾必须幂等、且不能假设自己抢先。
    await until(() => setup.ledger.get('req-gate-1')!.status !== 'pending')
    expect(setup.calls.write).toHaveLength(0)
    expect(setup.ledger.get('req-gate-1')!.status).toBe('recalled')
    // 「询问作废不等于批准作废」（ledger.ts）：这条记录在 `expiresAt` 之前照样能被批下来，
    // 所以卡片不能删，只把正文改成「本次询问已作废，这条审批仍可批准」。
    expect(cards.deferred).toEqual(['本次询问已作废，这条审批仍可批准'])
    expect(cards.recalls).toEqual([])
  })

  it('卡片上的点击推翻不了已经落账的更早决定（E4 在 responder 这一层）', async () => {
    const cards = fakeChannel()
    const setup = await boot({ windowMs: 5_000, answer: responderOf(cards) })
    const pending = execute(setup.ctx, call('write', escalated))
    await until(() => cards.sent.length === 1)

    // 第 4 步的回调路由在另一个进程里先把这条批准掉了
    expect(await setup.ledger.transition('req-gate-1', { from: ['pending'], to: 'rejected', set: { decidedBy: 'ou-carol', decidedAt: Date.now() } })).toBe(true)
    cards.sent[0]!.card.click('approve', 'ou-alice')
    const result = await pending

    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: 'Error: the user rejected tool "write"' })
    expect(setup.calls.write).toHaveLength(0)
    expect(setup.ledger.get('req-gate-1')!.decidedBy).toBe('ou-carol')
  })

  it('E13 渠道发不出卡片 → 交棒给下一个 answerer；内侧放行后记录退役成 consumed', async () => {
    const cards = fakeChannel({ down: true })
    const asked: ApprovalRequest[] = []
    const setup = await boot({
      windowMs: 5_000,
      answer: (ctx, ledger) => {
        installApprovalResponder(ctx, { ledger, channel: cards.channel })
        // 后注册的监听器 = Web UI 自带面板，在更内侧
        ctx.on('approval/request', (req) => {
          asked.push(req)
          return Promise.resolve<ApprovalOutcome>('allowed-once')
        })
      },
    })

    const result = await execute(setup.ctx, call('write', escalated))

    expect(cards.sent).toEqual([])
    expect(asked).toHaveLength(1)
    expect(result.isError).toBe(false)
    expect(setup.calls.write).toHaveLength(1)
    // 这一次询问已经被内侧应答者用掉了。留在 `pending` 就等于给同一次提权留了两条批准之路：
    // 一条迟到的 IM 批准会再落一张批件，同一个动作于是执行两次（§8 第 7 步真进程实测）。
    expect(setup.ledger.get('req-gate-1')!.status).toBe('consumed')
    // 不署名：是谁答的我们没有任何事实，伪造一个 open_id 会污染审计（D4 同一理由）。
    expect(setup.ledger.get('req-gate-1')!.decidedBy).toBeNull()
  })

  it('E13 内侧放行后的退役写不下去 ⇒ 报告，但已经作出的决策不回滚', async () => {
    const root = await newRoot()
    let armed = false
    const cards = fakeChannel({ down: true, onSend: () => { armed = true } })
    const reported: string[] = []
    const setup = await boot({
      root,
      windowMs: 5_000,
      backend: rejectingBackend(root, 'requests', () => armed),
      answer: (ctx, ledger) => {
        installApprovalResponder(ctx, {
          ledger,
          channel: cards.channel,
          onHandoffError: requestId => { reported.push(requestId) },
        })
        ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
      },
    })

    const result = await execute(setup.ctx, call('write', escalated))

    // 决策是面板给的，我们无权收回：工具照旧执行，缺的只是那一行退役。
    expect(result.isError).toBe(false)
    expect(setup.calls.write).toHaveLength(1)
    expect(reported).toEqual(['req-gate-1'])
    // 写不下去时内存里不留半个状态（E12 同一条契约），所以账上仍是一条待裁决记录。
    expect(setup.ledger.get('req-gate-1')!.status).toBe('pending')
  })

  it('E13 内侧拒绝或无人应答 ⇒ 不退役：那条批准的门该不该开，留给后面的裁决', async () => {
    const cards = fakeChannel({ down: true })
    const setup = await boot({
      windowMs: 5_000,
      answer: (ctx, ledger) => {
        installApprovalResponder(ctx, { ledger, channel: cards.channel })
        ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('rejected'))
      },
    })

    const result = await execute(setup.ctx, call('write', escalated))

    expect(result.isError).toBe(true)
    expect(setup.calls.write).toHaveLength(0)
    expect(setup.ledger.get('req-gate-1')!.status).toBe('pending')
  })

  it('E13 渠道故障且没有面板 → unavailable → 拒绝，绝不因渠道坏了就放行', async () => {
    const cards = fakeChannel({ down: true })
    const setup = await boot({ windowMs: 5_000, answer: responderOf(cards) })

    const result = await execute(setup.ctx, call('write', escalated))

    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: 'Error: tool "write" requires approval, but no approval channel is available' })
    expect(setup.calls.write).toHaveLength(0)
    expect(setup.ledger.get('req-gate-1')!.status).toBe('pending')
  })

  it('没有 callId 的询问（提权路径，F4）不是我们的问题：交棒，不发卡片', async () => {
    const cards = fakeChannel()
    const setup = await boot({ windowMs: 5_000, answer: responderOf(cards) })
    const outcome = await setup.ctx.approval.request({ agent: fakeAgent(), toolName: 'write' })

    expect(outcome).toBe('unavailable')
    expect(cards.sent).toEqual([])
  })
})

describe('responder：grants 命中时不再问第二次（§3.4.1③ 正确性要求）', () => {
  it('第二次 ask 消费授权直接放行，一张卡片都不发，记录迁 consumed', async () => {
    const cards = fakeChannel()
    const setup = await boot({ windowMs: 20, answer: responderOf(cards) })

    // 第一次询问：窗口到期作废 → expired，用户随后在别处批了（第 4 步的回调路由）
    await execute(setup.ctx, call('write', escalated))
    await until(() => cards.sent.length === 1)
    await until(() => setup.ledger.get('req-gate-1')!.status === 'expired')
    const now = Date.now()
    const approved = await setup.ledger.approve('req-gate-1', {
      decidedBy: 'ou-alice',
      now,
      grant: {
        grantId: 'g-1',
        toolName: 'write',
        argsDigest: argsDigest(escalated),
        grantExpiresAt: now + 60_000,
      },
    })
    expect(approved.won).toBe(true)

    // 冷会话醒来后的重放：U1 实测它一定会再触发一次 approval/request
    const replayed = { ...escalated, justification: '已获批准，按原参数重放这次写入' }
    const result = await execute(setup.ctx, call('write', replayed))

    expect(result.isError).toBe(false)
    // 第一次被作废时没执行（原调用尚未 dispatch），所以重放这一次就是唯一的一次执行
    expect(setup.calls.write).toHaveLength(1)
    // 只发过第一张卡；第二次 ask 直接凭 grant 放行 —— 否则同一个动作用户被问两遍
    expect(cards.sent).toHaveLength(1)
    expect(setup.issued).toEqual(['req-gate-1', 'req-gate-2'])
    expect(setup.ledger.get('req-gate-2')!.status).toBe('consumed')
    expect([...setup.ledger.grants.keys()]).toEqual([])
  })

  it('digest 失配（E9）不消费授权，照常发卡片问人', async () => {
    const cards = fakeChannel()
    const setup = await boot({ windowMs: 20, answer: responderOf(cards) })
    await execute(setup.ctx, call('write', escalated))
    await until(() => setup.ledger.get('req-gate-1')!.status === 'expired')
    const now = Date.now()
    await setup.ledger.approve('req-gate-1', {
      decidedBy: 'ou-alice',
      now,
      grant: { grantId: 'g-1', toolName: 'write', argsDigest: argsDigest(escalated), grantExpiresAt: now + 60_000 },
    })

    const drifted = { ...escalated, file_path: 'C:\\Users\\demo\\other.docx' }
    const pending = execute(setup.ctx, call('write', drifted))
    await until(() => cards.sent.length === 2)
    cards.sent[1]!.card.click('approve', 'ou-alice')
    const result = await pending

    expect(result.isError).toBe(false)
    expect([...setup.ledger.grants.keys()]).toEqual(['g-1'])
    expect(setup.ledger.get('req-gate-2')!.status).toBe('approved')
  })
})

describe('responder：同一次调用的第二次询问（真进程实测的提权双问）', () => {
  /**
   * 一次带 `sandbox_permissions` 的调用，内核会问**两次** `approval.request`，两次都是同一个 `callId`：
   * ①我们的闸在 `pre-execute` 返 `ask` 之后由服务自己发的那次；
   * ②工具体里 `approveEscalation`（`packages/sandbox/sandbox/src/escalation.ts:190`）为了改沙箱模式再发的那次。
   * 第 8 步真进程实测：①在窗口内被人点了「同意」之后，②走到 responder 时记录已经是 `approved`、
   * 又grant 可消费（同窗口放行从不落 grant），于是落回窗口逻辑**又发一张卡**等人点 ——
   * 而这张卡已经点不动了（回调路由不收已决记录），15:07:19 批准的动作一直堵到 15:17 窗口末尾。
   */
  function escalationAsk(ctx: Context, decision?: string) {
    return ctx.approval.request({
      agent: fakeAgent(),
      toolName: 'write',
      callId: ToolCallId('c1'),
      ...(decision === undefined ? {} : { reason: decision }),
    })
  }

  it('窗口内已批准的调用，工具体第二次问 → 直接兑现那次决定，一张卡都不多发', async () => {
    const cards = fakeChannel()
    const setup = await boot({ windowMs: 5_000, answer: responderOf(cards) })
    const pending = execute(setup.ctx, call('write', escalated))
    await until(() => cards.sent.length === 1)
    cards.sent[0]!.card.click('approve', 'ou-alice')
    expect((await pending).isError).toBe(false)

    expect(await escalationAsk(setup.ctx, 'escalate sandbox to danger-full-access')).toBe('allowed-once')
    expect(cards.sent).toHaveLength(1)
    expect(setup.issued).toEqual(['req-gate-1'])
    expect(setup.ledger.get('req-gate-1')!.status).toBe('approved')
  })

  it('已拒绝的调用，工具体第二次问 → rejected：第二次问绝不把一次拒绝变成放行', async () => {
    const cards = fakeChannel()
    const setup = await boot({ windowMs: 5_000, answer: responderOf(cards) })
    const pending = execute(setup.ctx, call('write', escalated))
    await until(() => cards.sent.length === 1)
    cards.sent[0]!.card.click('reject', 'ou-alice')
    expect((await pending).isError).toBe(true)

    expect(await escalationAsk(setup.ctx, 'escalate sandbox to danger-full-access')).toBe('rejected')
    expect(cards.sent).toHaveLength(1)
  })

  it('凭 grant 放行的重放，工具体第二次问 → 同样直接放行（批件已经消费掉了，不能再问人）', async () => {
    const cards = fakeChannel()
    const setup = await boot({ windowMs: 20, answer: responderOf(cards) })
    await execute(setup.ctx, call('write', escalated))
    await until(() => setup.ledger.get('req-gate-1')!.status === 'expired')
    const now = Date.now()
    await setup.ledger.approve('req-gate-1', {
      decidedBy: 'ou-alice',
      now,
      grant: { grantId: 'g-1', toolName: 'write', argsDigest: argsDigest(escalated), grantExpiresAt: now + 60_000 },
    })
    const replayed = { ...escalated, justification: '已获批准，按原参数重放这次写入' }
    expect((await execute(setup.ctx, call('write', replayed))).isError).toBe(false)
    expect(setup.ledger.get('req-gate-2')!.status).toBe('consumed')

    expect(await escalationAsk(setup.ctx, 'escalate sandbox to danger-full-access')).toBe('allowed-once')
    // 第一张卡 + 重放那次一张都不发
    expect(cards.sent).toHaveLength(1)
    expect(setup.issued).toEqual(['req-gate-1', 'req-gate-2'])
  })

  it('记录还在 pending 时第二次问 ≠ 已经批准：照样开窗口问人，绝不自己兑现', async () => {
    const cards = fakeChannel()
    const setup = await boot({ windowMs: 5_000, answer: responderOf(cards) })
    const pending = execute(setup.ctx, call('write', escalated))
    await until(() => cards.sent.length === 1)

    // 同一个 callId 的第二次询问落在第一次还没被答复时 —— 这不是「已批准」，不能自动放行。
    const second = escalationAsk(setup.ctx, 'escalate sandbox to danger-full-access')
    await until(() => cards.sent.length === 2)
    cards.sent[1]!.card.click('approve', 'ou-bob')
    cards.sent[0]!.card.click('approve', 'ou-bob')
    expect(await second).toBe('allowed-once')
    expect((await pending).isError).toBe(false)
  })
})

describe('E8：策略 never → 没人被打扰，提权被拒', () => {
  /** 一个宽容的监听器：只要 `approval/request` 真派发过，它就把动作放行。 */
  function permissiveListener(seen: ApprovalRequest[]) {
    return (req: ApprovalRequest): Promise<ApprovalOutcome> => {
      seen.push(req)
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    }
  }

  it('部署默认 never：闸先落快照再 ask，但服务在派发之前就判完，监听器一次都没触发', async () => {
    const cards = fakeChannel()
    const asked: ApprovalRequest[] = []
    const setup = await boot({
      windowMs: 5_000,
      approvalPolicy: 'never',
      answer: (ctx, ledger) => {
        installApprovalResponder(ctx, { ledger, channel: cards.channel })
        ctx.on('approval/request', permissiveListener(asked))
      },
    })

    const result = await execute(setup.ctx, call('write', escalated))

    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: 'Error: the user rejected tool "write"' })
    // 触发顺序是真的：闸先写快照、再交回 `ask`，所以「问过谁」这件事在账上留得下来。
    expect(setup.issued).toEqual(['req-gate-1'])
    expect(asked).toHaveLength(0)
    expect(cards.sent).toEqual([])
    expect(setup.calls.write).toHaveLength(0)
    // 留在 pending 而不是被谁拒掉：没有任何人做过这个决定，`decidedBy` 必须是空的。
    expect(setup.ledger.get('req-gate-1')).toMatchObject({ status: 'pending', decidedBy: null, decidedAt: null })
  })

  it('never 只管问不问，不管分级：L0 只读照常执行，一条记录都不落', async () => {
    const setup = await boot({ approvalPolicy: 'never' })
    const result = await execute(setup.ctx, call('read', { file_path: 'C:\\Users\\demo\\a.txt' }))

    expect(result.isError).toBe(false)
    expect(setup.calls.read).toHaveLength(1)
    expect(setup.issued).toEqual([])
  })

  it('会话内切到 never：覆盖部署默认的 ask，连后挂的 `{prepend:true}` 宽容监听器都问不到', async () => {
    const cards = fakeChannel()
    const asked: ApprovalRequest[] = []
    const setup = await boot({ windowMs: 5_000, answer: responderOf(cards) })
    // 注册顺序按最不利的一方排：responder 自己就是 `{prepend:true}` 挂的，而内核文档承诺
    // never 在**任何**监听器之前判定（`decide()` 的派发前分支）。再加一个更晚注册的 prepend，
    // 若它有机会被问到，动作就会被它放行 —— 断言的是「一次都没被问到」。
    setup.ctx.on('approval/request', permissiveListener(asked), { prepend: true })
    const agent = fakeAgent()
    setApprovalPolicy(agent.session, 'never')

    const result = await execute(setup.ctx, call('write', escalated), agent)

    expect(asked).toHaveLength(0)
    expect(cards.sent).toEqual([])
    expect(result.isError).toBe(true)
    expect(setup.calls.write).toHaveLength(0)
    expect(setup.issued).toEqual(['req-gate-1'])
  })

  it('同一会话换回 ask：卡片照发、窗口内的点击照常兑现（静默确实来自策略，不是测试装错了）', async () => {
    const cards = fakeChannel()
    const setup = await boot({ windowMs: 5_000, answer: responderOf(cards) })
    const agent = fakeAgent()
    setApprovalPolicy(agent.session, 'never')
    expect((await execute(setup.ctx, call('write', escalated), agent)).isError).toBe(true)

    setApprovalPolicy(agent.session, 'ask')
    const pending = execute(setup.ctx, call('write', escalated), agent)
    await until(() => cards.sent.length === 1)
    cards.sent[0]!.card.click('approve', 'ou-alice')

    expect((await pending).isError).toBe(false)
    expect(setup.calls.write).toHaveLength(1)
    expect(setup.ledger.get('req-gate-2')!.status).toBe('approved')
  })
})

describe('U8：never 档位是「信息性残留」而不是放行口子（配置面声明的 fail-closed 不变量）', () => {
  // 设计 §9 U8 定案＝候选①：不改 sweeper/gate 的行为接缝，把当前形态当成**已声明的残留噪声**收口。
  // 之所以能这么定，靠的是一条必须被断言的安全不变量：在 `never` 会话里，那张被催办推出去的卡
  // 就算真的点 down、就算台账里因此落下了一张批件，也**兑现不了任何执行** —— 因为内核的 never 分支
  // 在任何 `approval/request` 监听器之前就把这次提权判掉了（`responder.ts:134` 的 `consumeGrant`
  // 根本没有机会跑）。这条用例把「残留卡是惰性的」钉成可回归的事实，而不是只写在文档里的一句话。
  it('催办卡被点后落下的批件在 never 会话里既消费不掉、也不让动作执行（fail-closed 成立）', async () => {
    const cards = fakeChannel()
    const setup = await boot({ windowMs: 5_000, approvalPolicy: 'never', answer: responderOf(cards) })

    // 第一步：never 会话里发起一次提权写。闸照常落 pending 快照（审计要留痕），但服务在派发前判完。
    const first = await execute(setup.ctx, call('write', escalated))
    expect(first.isError).toBe(true)
    expect(setup.calls.write).toHaveLength(0)
    expect(setup.ledger.get('req-gate-1')!.status).toBe('pending')

    // 第二步：模拟「那张残留的催办卡被人在 IM 里点了」—— 直接经台账落一张与本次动作匹配的批件。
    // `never` 只管问不问、不管分级：批件的落账本身不受会话策略约束（它是回调路由那条独立路径的产物）。
    const approved = await setup.ledger.approve('req-gate-1', {
      decidedBy: 'ou-alice',
      now: Date.now(),
      grant: {
        grantId: 'grant-u8',
        toolName: 'write',
        argsDigest: argsDigest(escalated),
        grantExpiresAt: Date.now() + 60_000,
      },
    })
    expect(approved.won).toBe(true)
    expect(setup.ledger.hasOutstandingGrant('req-gate-1')).toBe(true)

    // 第三步：同一 never 会话再发一次**同工具同参数**的提权写。若批件能被消费，动作就会执行 ——
    // 那才是真的 fail-open。断言的是相反：动作仍不执行，且批件原封不动地留在账上（没人取得走它）。
    const second = await execute(setup.ctx, call('write', escalated))
    expect(second.isError).toBe(true)
    expect(setup.calls.write).toHaveLength(0)
    expect(setup.ledger.hasOutstandingGrant('req-gate-1')).toBe(true)
  })
})
