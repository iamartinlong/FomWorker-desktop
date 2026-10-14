/**
 * M1 恢复路径的验收单测（设计 §3.4 / §3.4.1，§8 第 5 步：E2 / E3 / E9 / E10 + 窗口交付 + E11）。
 *
 * 这一步跑的是**真回合**：真 `AgentLoop` + 真 inbox + 真 `tools/pre-execute` 闸 +
 * 真 `ApprovalService` + 真 json 台账 + 真定时器 + 真 dispatch，只有模型换成脚本
 * （产品里那一层本来就是真 provider）。所以「批准 → 起新 turn → 原样重放 → 工具恰好执行一次」
 * 是被跑出来的，不是被断言出来的。
 *
 * 两处只由测试提供，其余全真：
 * - `resolveAgent`：内核的冷会话恢复 `ctx.sessionController.resolveAgent` 要 session-query /
 *   typert / 会话持久化后端一整串依赖，属于真实组合 boot test 的范围；这里按内核 `schedule`
 *   自己测试的同一条先例（`packages/schedule/schedule/tests/harness.ts:90`）只提供这一层。
 * - `session/flush` 的应答者：真实后端是 `dsh-session-persistence-jsonl`（带 zstd/koffi 原生依赖，
 *   没接进本 harness）。`sessions.flush()` 的契约是「至少有一个应答者确认过」（`:1206`），
 *   所以这里注册一个承担那个位置的监听器；「没有应答者 ⇒ 恢复路径必须报告」那条用例故意不注册。
 *
 * 时钟一律用真的：同步窗口和批件有效期正是最会被假时钟掩盖的两样东西。
 */

import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  createApprovalCallbackHandler,
  feishuCardSignature,
  type CallbackInput,
  type CallbackRouteOptions,
} from './callback-route.ts'
import { createApprovalRecovery, type RecoveryFailure } from './recovery.ts'
import { ApprovalLedger, type TransitionGuard } from './ledger.ts'
import { installApprovalResponder, PendingApprovalWindows, type ApprovalCard, type ApprovalChannel, type ApprovalClick } from './responder.ts'
import {
  askAgent,
  boot,
  createRealAgent,
  escalated,
  installFlushAck,
  newRoot,
  ScriptedAdapter,
  sleep,
  textChunks,
  toolCallChunks,
  until,
  type Harness,
  type ScriptEntry,
} from './test-harness.ts'

const token = 'v-token-1'

/** 一次签名合法的卡片回调；时间戳用现在，路由那边有 5 分钟容差。 */
function callback(requestId: string, decision: 'approve' | 'reject', openId: string): CallbackInput {
  const rawBody = JSON.stringify({
    event: { operator: { open_id: openId }, action: { value: { requestId, decision } } },
  })
  const timestamp = String(Date.now())
  const nonce = 'nonce-1'
  return { rawBody, timestamp, nonce, signature: feishuCardSignature({ timestamp, nonce, token, body: rawBody }) }
}

/** 一张永远不会被点的卡：真实形态下点击是经回调路由进来的，渠道这边只负责等取消。 */
function unclictableCard(): ApprovalCard {
  return {
    cardId: 'card-unused',
    waitForClick: signal => new Promise<ApprovalClick | undefined>(resolve => {
      if (signal.aborted) resolve(undefined)
      else signal.addEventListener('abort', () => { resolve(undefined) }, { once: true })
    }),
  }
}

interface Scenario {
  harness: Harness
  agent: Agent
  adapter: ScriptedAdapter
  windows: PendingApprovalWindows
  respond: (input: CallbackInput) => Promise<{ status: number; body: unknown }>
  cardLog: { sent: string[]; updated: string[]; recalled: string[] }
  /** `hangSend` 时每次挂住的发卡，测试用它决定这次送达最终成功还是失败。 */
  pendingSends: { resolve: () => void; reject: (error: Error) => void }[]
  failures: { failure: RecoveryFailure; requestId: string }[]
  acks: { count: number }
  dispose: () => Promise<void>
}

/**
 * 装出产品组合：闸 → 面板（在内侧）→ 裁决者（`prepend`）→ 回调路由 → 恢复路径 → 真 agent。
 * 不传 `resolveAgent` 时默认解析到本用例自己造的那个 agent（等价于热会话被叫醒）。
 */
async function scenario(
  script: ScriptEntry[],
  options: {
    windowMs?: number
    /** 台账有效期（只改 L3，本文件的用例都走 L3 的提权写）。 */
    expiresMs?: number
    flushAck?: boolean
    sessionId?: string
    root?: string
    requestIdPrefix?: string
    /** 把「发卡」这次网络调用挂住，直到测试放开 —— 产品里卡片送达比点击慢得多。 */
    hangSend?: boolean
    resolveAgent?: (sessionId: string) => Promise<Agent | undefined>
  } = {},
): Promise<Scenario> {
  const cardLog = { sent: [] as string[], updated: [] as string[], deferred: [] as string[], recalled: [] as string[] }
  const pendingSends: { resolve: () => void; reject: (error: Error) => void }[] = []
  const channel: ApprovalChannel = {
    send: async record => {
      cardLog.sent.push(record.requestId)
      if (options.hangSend === true) {
        await new Promise<void>((resolve, reject) => { pendingSends.push({ resolve, reject }) })
      }
      return unclictableCard()
    },
    update: async (_card, text) => { cardLog.updated.push(text) },
    defer: async (_card, text) => { cardLog.deferred.push(text) },
    recall: async (_card, text) => { cardLog.recalled.push(text) },
  }
  const windows = new PendingApprovalWindows()
  const failures: { failure: RecoveryFailure; requestId: string }[] = []
  const acks = { count: 0 }
  const harness = await boot({
    windowMs: options.windowMs ?? 60,
    panelSimulator: true,
    ...(options.root === undefined ? {} : { root: options.root }),
    ...(options.requestIdPrefix === undefined ? {} : { requestIdPrefix: options.requestIdPrefix }),
    ...(options.expiresMs === undefined ? {} : { expiresMs: { L3: options.expiresMs } }),
    answer: (ctx, ledger) => {
      if (options.flushAck !== false) installFlushAck(ctx, acks)
      // 注册顺序与产品一致：面板在内侧，我们的裁决者靠 `{prepend:true}` 抢在它前面（U7）。
      installApprovalResponder(ctx, { ledger, channel, windows })
    },
  })
  const adapter = new ScriptedAdapter(script)
  const handle = await createRealAgent(harness, options.sessionId ?? 'recovery-session', adapter)
  const agent = handle.agent
  const recovery = createApprovalRecovery({
    ledger: harness.ledger,
    windows,
    resolveAgent: options.resolveAgent ?? (async sessionId => (sessionId === agent.session.id ? agent : undefined)),
    flush: session => harness.ctx.sessions.flush(session),
    onFailure: (failure, event) => { failures.push({ failure, requestId: event.record.requestId }) },
  })
  const respond = createApprovalCallbackHandler({
    ledger: harness.ledger,
    tenantId: 'tenant-1',
    verificationToken: () => token,
    approversOf: () => ['ou-alice', 'ou-bob'],
    onSettled: event => recovery(event),
  } satisfies CallbackRouteOptions)
  return {
    harness, agent, adapter, windows, respond, cardLog, pendingSends, failures, acks,
    dispose: async () => { await handle.dispose(); await harness.ctx.fiber.dispose() },
  }
}

/**
 * 等恢复路径自己跑起来。
 *
 * 路由**绝不 await** `onSettled`（飞书 3 秒窗口），所以 `respond()` 返回时唤醒多半还没启动，
 * 直接 `whenIdle()` 会立刻返回并把断言读成「什么都没发生」。
 */
async function settled(s: Scenario, predicate: () => boolean): Promise<void> {
  await until(predicate, '恢复路径没跑起来')
  await s.agent.whenIdle()
}

/** 会话日志里我们代投的那条决策消息的正文。 */
function messagesOfKind(agent: Agent, kind: string): string[] {
  const out: string[] = []
  for (const event of agent.session.snapshotEvents()) {
    if (event.type !== 'user/message') continue
    const data = event.data as { source?: { kind?: string }; content?: readonly { type: string; text?: string }[] }
    if (data.source?.kind !== kind) continue
    out.push((data.content ?? []).flatMap(block => block.type === 'text' ? [block.text ?? ''] : []).join(''))
  }
  return out
}

/** 内核自己写的审计对：每次询问一条 `approval/decided`。 */
function decidedOutcomes(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter(event => event.type === 'approval/decided')
    .map(event => (event.data as { outcome: string }).outcome)
}

function grantRows(harness: Harness): unknown[] {
  return [...harness.ledger.grants.entries()].map(([, row]) => row)
}

describe('恢复路径 · 延迟批准起新 turn 重放', () => {
  it('E2：窗口到期后的批准起一个新 turn，模型原样重放，工具恰好执行一次', async () => {
    const s = await scenario([
      toolCallChunks('c1', 'write', escalated),
      textChunks('等待审批'),
      // 重放时模型重写了一段 `justification` —— 这正是它不进 digest 的理由（§3.4.1①）。
      toolCallChunks('c2', 'write', { ...escalated, justification: '需要写到工作区之外的目标路径' }),
      textChunks('已写好'),
    ])
    askAgent(s.agent, '把报告写到工作区外')
    await s.agent.whenIdle()

    // 第一次询问在同步窗口里没人答：工具没执行，记录留在台账等延迟批准（D4 的作废不是拒绝）。
    expect(s.harness.calls.write).toHaveLength(0)
    expect(s.cardLog.sent).toHaveLength(1)
    expect(decidedOutcomes(s.agent)).toEqual(['cancelled'])
    const requestId = s.harness.issued[0]!
    expect(s.harness.ledger.get(requestId)?.status).toBe('expired')

    expect((await s.respond(callback(requestId, 'approve', 'ou-alice'))).status).toBe(200)
    await settled(s, () => s.harness.calls.write.length === 1)

    expect(s.harness.calls.write).toEqual([{ ...escalated, justification: '需要写到工作区之外的目标路径' }])
    // §3.4.1③：重放一定会再触发一次 ask，靠 grants 支路挡下第二张卡片 —— 没挡住的话用户会被问第二遍。
    expect(s.cardLog.sent).toHaveLength(1)
    expect(decidedOutcomes(s.agent)).toEqual(['cancelled', 'allowed-once'])
    // 重放那次 ask 是新的一次询问，所以它有自己的记录：`approved` 是决策事实，
    // `consumed` 是「这次没问人，因为账上已经有一张对得上号的批件」。
    expect(s.harness.issued).toEqual(['req-gate-1', 'req-gate-2'])
    expect(s.harness.ledger.get(requestId)?.status).toBe('approved')
    expect(s.harness.ledger.get('req-gate-2')?.status).toBe('consumed')
    expect(grantRows(s.harness)).toHaveLength(0)
    expect(s.failures).toEqual([])
    expect(s.acks.count).toBeGreaterThan(0)

    // 决策确实以 user 消息进了会话日志，并带着我们声明的那个 kind（F15）：重启后模型看得到发生过什么。
    const injected = messagesOfKind(s.agent, 'approval-decision')
    expect(injected).toHaveLength(1)
    expect(injected[0]).toContain(`编号 ${requestId}：写入 C:\\Users\\demo\\report.docx`)
    expect(injected[0]).toContain('由 ou-alice 批准')
    expect(injected[0]).toContain('tool_call_json: {"name":"write","arguments":')
    expect(injected[0]).toContain('"sandbox_permissions":"danger-full-access"')
    // `justification` 必须**跟着参数快照一起交回去**：内核 `validateEscalationArgs`
    // （`packages/sandbox/sandbox/src/escalation.ts:52`）规定带 `sandbox_permissions` 就必须带
    // 非空 `justification`，否则工具在派发之前就抛 `invalid escalation: sandbox_permissions requires a justification`。
    // 剔掉它等于让每一次提权动作的后台重放第一次必败（第 8 步真进程实测过）。
    // digest 不含 `justification`，所以带上它不会影响批件匹配（§3.4.1①）。
    expect(injected[0]).toContain('"justification"')
    expect(injected[0]).toContain(escalated.justification)
    await s.dispose()
  }, 20_000)

  it('E9：重放时参数已经变了 ⇒ 批件不消费，重新问人，未获批准就不执行', async () => {
    const s = await scenario([
      toolCallChunks('c1', 'write', escalated),
      textChunks('等待审批'),
      toolCallChunks('c2', 'write', { ...escalated, content: 'changed while waiting' }),
      textChunks('我改了内容再写'),
    ])
    askAgent(s.agent, '把报告写到工作区外')
    await s.agent.whenIdle()
    const requestId = s.harness.issued[0]!
    await s.respond(callback(requestId, 'approve', 'ou-alice'))
    await settled(s, () => s.cardLog.sent.length === 2)

    // digest 失配 ⇒ 那张批件仍然在账上（谁也没消费它），第二次询问照旧发卡片。
    expect(s.harness.calls.write).toHaveLength(0)
    expect(s.harness.issued).toEqual(['req-gate-1', 'req-gate-2'])
    expect(s.harness.ledger.get(requestId)?.status).toBe('approved')
    expect(s.harness.ledger.get('req-gate-2')?.status).toBe('expired')
    expect(grantRows(s.harness)).toHaveLength(1)
    expect(decidedOutcomes(s.agent)).toEqual(['cancelled', 'cancelled'])
    await s.dispose()
  }, 20_000)

  it('E10：批件在等待重放期间过期 ⇒ 不消费，回落到标准询问', async () => {
    // 窗口 60ms、有效期 2000ms：批准落在两者之间（合法），重放那一次 dispatch 一直被压到
    // `expiresAt` 之后才放开 —— 批件在「已经批了但还没执行」这段时间里到期了。
    // 等待时长按记录上的真实时刻算，不写死毫秒数：回合调度慢一点就会把批准挤到有效期之外，
    // 那时路由回的是「已过期」，用例测的就不是批件到期而是别的东西了。
    const s = await scenario([
      toolCallChunks('c1', 'write', escalated),
      textChunks('等待审批'),
      { holdBefore: toolCallChunks('c2', 'write', escalated) },
      textChunks('已写好'),
    ], { expiresMs: 2000 })
    askAgent(s.agent, '把报告写到工作区外')
    await s.agent.whenIdle()
    const requestId = s.harness.issued[0]!
    expect((await s.respond(callback(requestId, 'approve', 'ou-alice'))).status).toBe(200)
    await until(() => s.adapter.requests.length === 3, '重放的那次模型请求没起来')
    const expiresAt = s.harness.ledger.get(requestId)!.expiresAt
    await sleep(Math.max(0, expiresAt - Date.now()) + 20)
    s.adapter.release()
    await settled(s, () => s.cardLog.sent.length === 2)

    expect(s.harness.calls.write).toHaveLength(0)
    expect(s.harness.issued).toEqual(['req-gate-1', 'req-gate-2'])
    expect(grantRows(s.harness)).toHaveLength(1)
    // 记录本身仍是「已批准」这个事实；只是那张批件再也没人能消费。
    expect(s.harness.ledger.get(requestId)).toMatchObject({ status: 'approved', decidedBy: 'ou-alice' })
    expect(s.harness.ledger.get('req-gate-2')?.status).toBe('expired')
    await s.dispose()
  }, 20_000)

  it('拒绝也要送到模型面前：模型不再尝试，也没有任何执行', async () => {
    const s = await scenario([
      toolCallChunks('c1', 'write', escalated),
      textChunks('等待审批'),
      textChunks('好的，我不再尝试这个写入'),
    ])
    askAgent(s.agent, '把报告写到工作区外')
    await s.agent.whenIdle()
    const requestId = s.harness.issued[0]!
    await s.respond(callback(requestId, 'reject', 'ou-bob'))
    await settled(s, () => messagesOfKind(s.agent, 'approval-decision').length === 1)

    expect(s.harness.calls.write).toHaveLength(0)
    expect(s.harness.ledger.get(requestId)).toMatchObject({ status: 'rejected', decidedBy: 'ou-bob' })
    expect(grantRows(s.harness)).toHaveLength(0)
    const injected = messagesOfKind(s.agent, 'approval-decision')
    expect(injected).toHaveLength(1)
    expect(injected[0]).toContain('由 ou-bob 拒绝')
    expect(injected[0]).toContain('不要再次尝试这个动作')
    // 拒绝不产生新的询问：模型这一轮只回了文本。
    expect(s.harness.issued).toEqual(['req-gate-1'])
    await s.dispose()
  }, 20_000)
})

describe('恢复路径 · 与同步窗口的并发', () => {
  it('回调在窗口还开着时到达 ⇒ 交给窗口，不注入消息、不起第二个 turn', async () => {
    const s = await scenario([
      toolCallChunks('c1', 'write', escalated),
      textChunks('已写好'),
    ], { windowMs: 2_000 })
    askAgent(s.agent, '把报告写到工作区外')
    await until(() => s.cardLog.sent.length === 1, '卡片没发出去')

    const requestId = s.harness.issued[0]!
    await s.respond(callback(requestId, 'approve', 'ou-alice'))
    await settled(s, () => s.harness.calls.write.length === 1)

    // 那次在飞的调用直接拿到了 allowed-once：台账上只有一条记录，会话日志里没有决策消息。
    expect(s.harness.calls.write).toHaveLength(1)
    expect(s.harness.issued).toEqual([requestId])
    expect(messagesOfKind(s.agent, 'approval-decision')).toHaveLength(0)
    expect(s.adapter.requests).toHaveLength(2)
    expect(decidedOutcomes(s.agent)).toEqual(['allowed-once'])
    // 批件必须收回：留着它，之后任何一次同工具同参数的调用都会不问自取地执行。
    // 收回排在通知里而路由不 await 通知（3 秒窗口），所以这里等到它落地而不是猜时长 ——
    // 落地前那段空隙是这条路径的已知残余风险，记在 §3.4。
    await until(() => grantRows(s.harness).length === 0, '批件没被当场收回')
    expect(s.harness.ledger.get(requestId)?.status).toBe('approved')
    await s.dispose()
  }, 20_000)

  it('批准落在卡片还没送达时 ⇒ 窗口仍然接得住，不另起一个 turn', async () => {
    const s = await scenario([
      toolCallChunks('c1', 'write', escalated),
      textChunks('已写好'),
    ], { windowMs: 2_000, hangSend: true })
    askAgent(s.agent, '把报告写到工作区外')
    await until(() => s.cardLog.sent.length === 1, '卡片没开始发')

    const requestId = s.harness.issued[0]!
    await s.respond(callback(requestId, 'approve', 'ou-alice'))
    // 窗口登记排在发卡之前，所以这次批准被认领了：既不注入决策消息，也不起第二个 turn。
    expect(s.agent.inbox.nextTurn).toHaveLength(0)
    expect(s.adapter.requests).toHaveLength(1)

    s.pendingSends[0]!.resolve()
    await settled(s, () => s.harness.calls.write.length === 1)
    expect(messagesOfKind(s.agent, 'approval-decision')).toHaveLength(0)
    expect(s.harness.issued).toEqual([requestId])
    await until(() => grantRows(s.harness).length === 0, '批件没被当场收回')
    await s.dispose()
  }, 20_000)

  it('卡片送达失败但批准已经到达 ⇒ 结局照用，不能当渠道故障交棒吞掉', async () => {
    const s = await scenario([
      toolCallChunks('c1', 'write', escalated),
      textChunks('已写好'),
    ], { windowMs: 2_000, hangSend: true })
    askAgent(s.agent, '把报告写到工作区外')
    await until(() => s.cardLog.sent.length === 1, '卡片没开始发')

    const requestId = s.harness.issued[0]!
    await s.respond(callback(requestId, 'approve', 'ou-alice'))
    // 点击能发生就说明卡片其实送达过；此时 send 再失败只是回执丢了，不是「没人答」。
    s.pendingSends[0]!.reject(new Error('card delivery timed out'))
    await settled(s, () => s.harness.calls.write.length === 1)

    expect(decidedOutcomes(s.agent)).toEqual(['allowed-once'])
    expect(messagesOfKind(s.agent, 'approval-decision')).toHaveLength(0)
    expect(s.harness.ledger.get(requestId)?.status).toBe('approved')
    await until(() => grantRows(s.harness).length === 0, '批件没被当场收回')
    await s.dispose()
  }, 20_000)

  it('E11：会话正忙时批准 ⇒ 决策排进 inbox，不并发第二个 turn', async () => {
    const s = await scenario([
      toolCallChunks('c1', 'write', escalated),
      textChunks('等待审批'),
      // 用户接着问了别的事，那一轮正卡在模型流里 —— 批准只能排队。
      { holdBefore: textChunks('目录里有 report.docx') },
      toolCallChunks('c2', 'write', escalated),
      textChunks('已写好'),
    ])
    askAgent(s.agent, '把报告写到工作区外')
    await s.agent.whenIdle()
    const requestId = s.harness.issued[0]!

    askAgent(s.agent, '目录里有什么')
    await until(() => s.adapter.requests.length === 3, '第二个 turn 没起来')

    await s.respond(callback(requestId, 'approve', 'ou-alice'))
    // 决策进了 inbox 但没有第二个 turn 在跑：内核把 turn 串行化了，这里验的是我们没绕过它。
    await until(() => s.agent.inbox.nextTurn.length === 1, '决策没排进 inbox')
    expect(s.adapter.requests).toHaveLength(3)
    expect(s.harness.calls.write).toHaveLength(0)

    s.adapter.release()
    await settled(s, () => s.harness.calls.write.length === 1)
    // 排队的决策排在忙的那一轮之后跑，工具仍然只执行一次。
    expect(s.agent.inbox.nextTurn).toHaveLength(0)
    expect(s.harness.issued).toEqual(['req-gate-1', 'req-gate-2'])
    expect(s.harness.ledger.get('req-gate-2')?.status).toBe('consumed')
    expect(grantRows(s.harness)).toHaveLength(0)
    await s.dispose()
  }, 20_000)
})

describe('恢复路径 · 唤醒失败与重启', () => {
  it('会话唤不起来 ⇒ 报告，并把批准补偿回可批准状态（重新点一次仍能成）', async () => {
    const s = await scenario([
      toolCallChunks('c1', 'write', escalated),
      textChunks('等待审批'),
    ], { resolveAgent: async () => undefined })
    askAgent(s.agent, '把报告写到工作区外')
    await s.agent.whenIdle()
    const requestId = s.harness.issued[0]!
    await s.respond(callback(requestId, 'approve', 'ou-alice'))
    await until(() => s.failures.length === 1, '唤醒失败没被报告')

    expect(s.failures[0]).toEqual({ failure: 'agent-unresolvable', requestId })
    expect(s.harness.calls.write).toHaveLength(0)
    // 补偿的两半：批件收回、状态退回 `expired`（仍在可批准集合里）。
    expect(grantRows(s.harness)).toHaveLength(0)
    expect(s.harness.ledger.get(requestId)?.status).toBe('expired')

    const retry = await s.respond(callback(requestId, 'approve', 'ou-alice'))
    expect(retry.status).toBe(200)
    expect(s.harness.ledger.get(requestId)?.status).toBe('approved')
    expect(grantRows(s.harness)).toHaveLength(1)
    await s.dispose()
  }, 20_000)

  it('补偿的退回写半路失败 ⇒ 绝不留下「已批准但批件已被收回、唤醒永不到来」的死账，且必须报告', async () => {
    // 这条用例钉住 F-F/#33 的中间态：窗口已关、会话唤不醒 ⇒ 走 compensate。
    // compensate 里那步 `approved → expired` 的退回写在真实 json 台账上 normally 不会抛，
    // 所以这里换成一个「退回 expired 时抛」的子类台账（不靠 `as unknown as` 塞假账本），
    // 复现「批件已收回 / 状态退回失败」这一半程失败。
    const harness = await boot({ windowMs: 60 })
    const requestId = 'req-comp-fail-1'
    await harness.ledger.create({
      requestId,
      sessionId: 'dead-account-session',
      tenantId: 'tenant-1',
      toolName: 'write',
      riskLevel: 'L3',
      actionSummary: '写入 C:\\Users\\demo\\report.docx',
      toolArgs: escalated,
      displayReason: '目标在工作区之外',
      status: 'pending',
      askedAt: Date.now(),
      windowEndsAt: Date.now() + 60,
      expiresAt: Date.now() + 60_000,
      decidedBy: null,
      decidedAt: null,
    })
    // 走台账自己的 approve（真迁移 + 真批件），不碰恢复路径 —— 造出「已批准 + 批件在账」的起点。
    await harness.ledger.approve(requestId, {
      decidedBy: 'ou-alice',
      now: Date.now(),
      grant: { grantId: 'grant-comp-1', toolName: 'write', argsDigest: 'dig', grantExpiresAt: Date.now() + 60_000 },
    })
    expect(harness.ledger.get(requestId)?.status).toBe('approved')
    expect([...harness.ledger.grants.entries()].map(([id]) => id)).toEqual(['grant-comp-1'])

    class RejectsDowngrade extends ApprovalLedger {
      override async transition(id: string, guard: TransitionGuard): Promise<boolean> {
        if (guard.to === 'expired') throw new Error('simulated write-chain failure')
        return super.transition(id, guard)
      }
    }
    const faulty = new RejectsDowngrade(harness.domain)
    const failures: RecoveryFailure[] = []
    const recovery = createApprovalRecovery({
      ledger: faulty,
      windows: new PendingApprovalWindows(),
      resolveAgent: async () => undefined,
      flush: async () => true,
      onFailure: failure => { failures.push(failure) },
    })

    await recovery({ record: harness.ledger.get(requestId)!, decision: 'approve', grantId: 'grant-comp-1' })

    // 修复后的不变量（改哪一侧由这条断言定：改恢复路径的 compensate 顺序，而不是改台账）：
    // ① 批件没被收回 —— 留着它，重启后的重放或下一次唤醒仍能消费，不会变成「批了却永远执行不了」；
    expect([...harness.ledger.grants.entries()].map(([id]) => id)).toEqual(['grant-comp-1'])
    // ② 记录仍是 `approved`（退回失败但绝没有先斩后奏地把批件删掉）；
    expect(harness.ledger.get(requestId)?.status).toBe('approved')
    // ③ 这半程失败必须被报告出来，而不是静默吞掉。
    expect(failures).toContain('compensation-incomplete')
    // 唤醒本身也没成功，那条事实同样报告（两条各自独立）。
    expect(failures).toContain('agent-unresolvable')
    // 全程没有执行、也没有起 turn（这里根本没有 agent）。
    expect(harness.calls.write).toHaveLength(0)
    await harness.ctx.fiber.dispose()
  }, 20_000)

  it('持久化没确认时不谎报成功：报告缺确认，但已投递的决策不回滚', async () => {
    const s = await scenario([
      toolCallChunks('c1', 'write', escalated),
      textChunks('等待审批'),
      toolCallChunks('c2', 'write', escalated),
      textChunks('已写好'),
    ], { flushAck: false })
    askAgent(s.agent, '把报告写到工作区外')
    await s.agent.whenIdle()
    const requestId = s.harness.issued[0]!
    await s.respond(callback(requestId, 'approve', 'ou-alice'))
    await settled(s, () => s.harness.calls.write.length === 1)

    expect(s.failures).toEqual([{ failure: 'persistence-unacknowledged', requestId }])
    expect(s.acks.count).toBe(0)
    // 消息在内存里已经生效、重放也跑了，所以这里**不能**补偿：收回批件只会让这轮重放重新问一遍人。
    expect(s.harness.calls.write).toHaveLength(1)
    expect(s.harness.ledger.get(requestId)?.status).toBe('approved')
    await s.dispose()
  }, 20_000)

  it('E3：进程重启后批准仍然能裁决，并把动作在第二个进程里跑完', async () => {
    const root = await newRoot()
    const first = await scenario([
      toolCallChunks('c1', 'write', escalated),
      textChunks('等待审批'),
    ], { root, sessionId: 'restart-session' })
    askAgent(first.agent, '把报告写到工作区外')
    await first.agent.whenIdle()
    const requestId = first.harness.issued[0]!
    expect(first.harness.ledger.get(requestId)?.status).toBe('expired')
    await first.dispose()

    // 第二个进程：同一个存储根目录，台账从磁盘读回来（解 M0 C4「pending 审批不持久」）。
    // 会话本身没有持久化（本 harness 没装 jsonl 后端），但恢复路径只依赖台账里的
    // `sessionId`、参数快照与编号 —— 重启后能批靠的就是这几样。
    const second = await scenario([
      toolCallChunks('c9', 'write', escalated),
      textChunks('已写好'),
    ], { root, sessionId: 'restart-session', requestIdPrefix: 'p2' })
    expect(second.harness.ledger.get(requestId)).toMatchObject({
      status: 'expired', sessionId: 'restart-session', toolName: 'write',
    })

    expect((await second.respond(callback(requestId, 'approve', 'ou-alice'))).status).toBe(200)
    await settled(second, () => second.harness.calls.write.length === 1)

    expect(second.harness.calls.write).toEqual([escalated])
    expect(second.harness.ledger.get(requestId)).toMatchObject({ status: 'approved', decidedBy: 'ou-alice' })
    // 新进程里的重放同样先过闸：它有自己的记录，靠批件免问。
    expect(second.harness.issued).toEqual(['p2-1'])
    expect(second.harness.ledger.get('p2-1')?.status).toBe('consumed')
    expect(grantRows(second.harness)).toHaveLength(0)
    expect(messagesOfKind(second.agent, 'approval-decision')).toHaveLength(1)
    await second.dispose()
  }, 20_000)
})
