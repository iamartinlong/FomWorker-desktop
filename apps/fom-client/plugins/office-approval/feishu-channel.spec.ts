/**
 * 飞书审批卡片渠道的验收单测（设计 §3.3 的 `ApprovalChannel`、§3.5 的两个动作、§4 的人因防线、
 * §5 的卡片二次确认；§8 第 6 步）。
 *
 * 网络全部注入：假 `transport` 记下每一次调用的**方法、路径、查询串、正文与所带 token**，
 * 于是官方文档那几条约束（`code != 0` 即失败、`uuid` 是请求级去重、就地改卡只能 PATCH 卡片消息、
 * 撤回是删除）是被调用序列证明的，而不是被注释声明的。卡片形状是纯函数，所以 §4 那几条人因要求
 * 逐条钉得住，不必等真应用联调时靠人眼看出。
 *
 * 台账用真 json 后端：卡片句柄（`message_id` 列表）存在的意义就是「重启之后还改得动那张卡」，
 * mock 掉台账就只剩一个内存 Map，那条主张没人验。
 */

import { describe, expect, it } from 'vitest'
import {
  alreadyGoneCodes,
  buildApprovalCard,
  cardUuid,
  cardValue,
  createFeishuApprovalChannel,
  createTenantTokenSource,
  FeishuApiError,
  installFeishuApprovalChannel,
  needsSecondConfirm,
  sessionRelaxationCount,
  sessionRepeatAsks,
  tokenInvalidCodes,
  type ApprovalCardState,
  type CardPolicy,
  type FeishuCall,
  type FeishuCardPayload,
  type FeishuReply,
  type FeishuTransport,
  type TokenSource,
} from './feishu-channel.ts'
import { argsDigest, type ApprovalRequestRecord } from './ledger.ts'
import type { ApprovalCard } from './responder.ts'
import { createApprovalCallbackHandler, feishuCardSignature } from './callback-route.ts'
import { boot, newRoot, type Harness } from './test-harness.ts'

const askedAt = 1_700_000_000_000
const pushedAt = askedAt + 1_000

/**
 * 飞书 `uuid` 字段的长度上限。第 8 步实测的边界证据：57 字符（原样拼 36 字符 requestId）被
 * `99992402 field validation failed` 整条拒绝；我们的构造最长 33 字符，留有余量。
 */
const FEISHU_UUID_MAX = 50

function request(overrides: Partial<ApprovalRequestRecord> & { requestId: string }): ApprovalRequestRecord {
  return {
    sessionId: 'session-1',
    tenantId: 'tenant-1',
    toolName: 'write',
    riskLevel: 'L3',
    actionSummary: '写入报告到工作区外',
    // 正文里绝不出现的四个值：路径、文件内容、提权参数、提权理由。最小暴露那条用例靠它们取证。
    toolArgs: {
      file_path: 'C:\\Users\\demo\\report.docx',
      content: 'SECRET_BODY_TEXT',
      sandbox_permissions: 'danger-full-access',
      justification: 'ESCALATION_NOTE',
    },
    displayReason: '目标在会话工作区之外，workspace-write 已拒。',
    status: 'pending',
    askedAt,
    windowEndsAt: askedAt + 90_000,
    expiresAt: askedAt + 4 * 60 * 60_000,
    decidedBy: null,
    decidedAt: null,
    ...overrides,
  }
}

const policy: CardPolicy = { relaxationCount: () => 2, repeatAsks: () => 1 }

/* ---------------------------- 卡片读取助手 ---------------------------- */

interface CardButton {
  tag: 'button'
  text: { content: string }
  type: string
  disabled: boolean
  confirm?: { title: { content: string }; text: { content: string } }
  behaviors: { type: string; value: { requestId: string; decision: string } }[]
}

function buttons(card: FeishuCardPayload): CardButton[] {
  // 2.0 里按钮**平铺**在 body.elements（第 8 步对真应用实测：`action` 容器被拒
  // `ErrCode 200861 unsupported tag action`）。这里按 tag 取，等于把「不再有 action 包装」钉住。
  return card.body.elements.filter(element => element.tag === 'button') as unknown as CardButton[]
}

function markdowns(card: FeishuCardPayload): string[] {
  return card.body.elements
    .filter(element => element.tag === 'div')
    .map(element => (element as unknown as { text: { content: string } }).text.content)
}

function footer(card: FeishuCardPayload): { tag: string; color: string; text: { content: string } } {
  return (card.header as {
    text_tag_list: { tag: string; color: string; text: { content: string } }[]
  }).text_tag_list[0]!
}

/** 批准按钮回传的那个 `action.value` —— 第 4 步没验的形状在这里闭合。 */
function approveValue(card: FeishuCardPayload): unknown {
  return buttons(card)[0]!.behaviors[0]!.value
}

/** 一张「已经点过」的卡：渠道的 `update` 与 `recall` 只读它的 `cardId`。 */
const clicked = (cardId: string): ApprovalCard => ({ cardId, waitForClick: async () => undefined })

/* -------------------------------- 假传输 -------------------------------- */

const api = (status: number, code: number, msg: string): FeishuReply => ({ status, code, msg })

/**
 * 默认每次发卡路给一个递增的 `message_id`（按调用在整个序列里的下标编号），
 * 用例只覆盖它要失败的那一次 —— 谁被拒由下标决定，不靠猜字符串。
 */
function fakeFeishu(handler: (call: FeishuCall, index: number) => FeishuReply | undefined = () => undefined): {
  transport: FeishuTransport
  calls: FeishuCall[]
} {
  const calls: FeishuCall[] = []
  return {
    calls,
    async transport(call) {
      const index = calls.length
      calls.push(call)
      return handler(call, index) ?? defaultReply(call, index)
    },
  }
}

function defaultReply(call: FeishuCall, index: number): FeishuReply {
  if (call.method === 'POST' && call.path === '/open-apis/im/v1/messages') {
    return { status: 200, code: 0, data: { message_id: `om-${String(index + 1)}` } }
  }
  return { status: 200, code: 0, data: {} }
}

function staticTokens(invalidations: number[] = []): TokenSource {
  return {
    token: async () => 't-1',
    invalidate() { invalidations.push(1) },
  }
}

interface ChannelFixture {
  channel: ReturnType<typeof createFeishuApprovalChannel>
  calls: FeishuCall[]
  failures: { error: unknown; path: string; requestId?: string | undefined }[]
}

function channelFixture(harness: Harness, options: {
  handler?: (call: FeishuCall, index: number) => FeishuReply | undefined
  recipientsOf?: (record: ApprovalRequestRecord) => readonly string[] | undefined
  initiatorOf?: (record: ApprovalRequestRecord) => string | undefined
  tokens?: TokenSource
  policy?: CardPolicy
} = {}): ChannelFixture {
  const feishu = fakeFeishu(options.handler)
  const failures: ChannelFixture['failures'] = []
  const channel = createFeishuApprovalChannel({
    transport: feishu.transport,
    tokens: options.tokens ?? staticTokens(),
    ledger: harness.ledger,
    policy: options.policy ?? policy,
    recipientsOf: options.recipientsOf ?? (() => ['ou-alice']),
    initiatorOf: options.initiatorOf ?? (() => 'ou-boss'),
    now: () => pushedAt,
    onFailure: (error, context) => { failures.push({ error, path: context.path, requestId: context.requestId }) },
  })
  return { channel, calls: feishu.calls, failures }
}

const sentCard = (call: FeishuCall): FeishuCardPayload =>
  JSON.parse((call.body as { content: string }).content) as FeishuCardPayload

/** 「方法 + 目标」的调用序列摘要：一次操作的网络形状整条钉住。 */
function trace(calls: FeishuCall[]): string[] {
  return calls.map(call => {
    const body = call.body as { receive_id?: string } | undefined
    const tail = call.path.split('/').pop()!
    return `${call.method} ${call.method === 'POST' ? body?.receive_id ?? tail : tail}`
  })
}

/* ------------------------------------------------------------------------ */

describe('卡片形状（§4 人因防线 + §5 二次确认）', () => {
  it('提权原文照搬（D8），参数只以指纹出现（§4 最小暴露）', () => {
    const record = request({ requestId: 'req-1' })
    const card = buildApprovalCard(record, { kind: 'awaiting' }, policy)
    const json = JSON.stringify(card)

    expect(card.schema).toBe('2.0')
    expect(card.config).toEqual({ update_multi: true })
    expect(card.header).toMatchObject({ title: { tag: 'plain_text', content: '审批请求 · write' } })
    // 原文照搬：第一个 div 与 `displayReason` 逐字相等 —— 重述一次就会失真。
    expect(markdowns(card)[0]).toBe(record.displayReason)
    expect(markdowns(card)[1]).toContain(argsDigest(record.toolArgs as Record<string, unknown>).slice(0, 12))
    expect(json).not.toContain('SECRET_BODY_TEXT')
    expect(json).not.toContain('danger-full-access')
    expect(json).not.toContain('ESCALATION_NOTE')
    expect(json).not.toContain('Users')
  })

  it('L3：先给两条不用放宽权限的做法，再给累计次数', () => {
    const card = buildApprovalCard(request({ requestId: 'req-1' }), { kind: 'awaiting' }, policy)
    const advice = markdowns(card).find(text => text.includes('改用工作区内的路径'))
    if (advice === undefined) throw new Error('卡片没给「不用放宽权限」的替代做法')

    // M0 F4 实测模型会主动建议放宽权限，所以卡片不能替它把这条路摆在第一个。
    expect(advice.indexOf('① 改用工作区内的路径')).toBeLessThan(advice.indexOf('② 让 Agent 换一种做法'))
    expect(advice.indexOf('② 让 Agent 换一种做法')).toBeLessThan(advice.indexOf('放宽权限会绕过沙箱保护'))
    expect(advice).toContain('本会话已累计放宽 2 次')
  })

  it('L1/L2 不进这段提示：分级不同，话术不该一样', () => {
    for (const riskLevel of ['L0', 'L1', 'L2'] as const) {
      const card = buildApprovalCard(request({ requestId: 'req-1', riskLevel }), { kind: 'awaiting' }, policy)
      expect(markdowns(card).some(text => text.includes('放宽权限'))).toBe(false)
      expect(needsSecondConfirm(riskLevel)).toBe(false)
    }
    expect(needsSecondConfirm('L3')).toBe(true)
    expect(needsSecondConfirm('L4')).toBe(true)
  })

  it('二次确认只挂在 L3/L4 的批准按钮上，且回传值与一级点击完全相同', () => {
    const card = buildApprovalCard(request({ requestId: 'req-1' }), { kind: 'awaiting' }, policy)
    const [approve, reject] = buttons(card)

    expect(approve?.confirm).toEqual({
      title: { tag: 'plain_text', content: '确认L3动作？' },
      text: { tag: 'plain_text', content: '这个动作不可逆，确认后立刻执行且不再询问。' },
    })
    // 拒绝不需要确认：它是最安全的那个动作。
    expect(reject?.confirm).toBeUndefined()
    // 弹窗不改回传值 —— 所以服务端不认任何「已确认」标记：那是客户端字段，改不了账。
    expect(approve?.behaviors).toEqual([{ type: 'callback', value: cardValue('req-1', 'approve') }])
    expect(reject?.behaviors).toEqual([{ type: 'callback', value: cardValue('req-1', 'reject') }])
    expect(approve?.text.content).toBe('确认批准（不可逆）')
    expect(approve?.type).toBe('primary')
    expect(reject?.type).toBe('danger')

    const l1 = buildApprovalCard(request({ requestId: 'req-2', riskLevel: 'L1' }), { kind: 'awaiting' }, policy)
    expect(buttons(l1)[0]?.confirm).toBeUndefined()
    expect(buttons(l1)[0]?.text.content).toBe('批准')
  })

  it('L4 的确认文案说清影响范围是整租户', () => {
    const card = buildApprovalCard(request({ requestId: 'req-1', riskLevel: 'L4' }), { kind: 'awaiting' }, policy)
    expect(buttons(card)[0]?.confirm?.text.content).toContain('整个租户')
    expect(buttons(card)[0]?.confirm?.title.content).toBe('确认L4动作？')
  })

  it('终态：按钮置灰、确认框消失、页脚写明发生了什么', () => {
    const record = request({ requestId: 'req-1' })
    const cases: [ApprovalCardState, string, string][] = [
      [{ kind: 'decided', text: '已由 ou-alice 批准' }, '已决策', 'green'],
      [{ kind: 'expired' }, '已过期', 'grey'],
      [{ kind: 'superseded' }, '已取代', 'grey'],
    ]
    for (const [state, label, color] of cases) {
      const card = buildApprovalCard(record, state, policy)
      expect(footer(card).text.content).toBe(label)
      expect(footer(card).color).toBe(color)
      for (const button of buttons(card)) {
        expect(button.disabled).toBe(true)
        expect(button.confirm).toBeUndefined()
      }
    }
    // 决策文案由 responder 给的那句话原样落进正文（E1）；过期文案不写成「被拒绝」（D4）。
    expect(markdowns(buildApprovalCard(record, { kind: 'decided', text: '已由 ou-alice 批准' }, policy)))
      .toContain('已由 ou-alice 批准')
    expect(markdowns(buildApprovalCard(record, { kind: 'expired' }, policy)).join('')).toContain('不再受理')

    // 待批准、已催办、已转后台是仅有的三个可点状态。
    expect(buttons(buildApprovalCard(record, { kind: 'awaiting' }, policy))[0]?.disabled).toBe(false)
    const reminded = buildApprovalCard(record, { kind: 'reminded' }, policy)
    expect(buttons(reminded)[0]?.disabled).toBe(false)
    expect(buttons(reminded)[0]?.confirm).toBeDefined()
    expect(footer(reminded).text.content).toBe('待批准 · 已催办')
    expect(markdowns(reminded)).toContain('这是**唯一一次**催办：仍未获得批准。')

    // 「转后台」必须是**还能点**的那一种：这条审批的门还开着（`isDecidable`），
    // 把按钮置灰就等于口头说「仍可批准」、手上把入口关掉（第 8 步 F-E）。
    const deferred = buildApprovalCard(record, { kind: 'deferred', text: '同步窗口内没人应答，已转后台等待审批' }, policy)
    expect(footer(deferred).text.content).toBe('待批准 · 转后台')
    expect(footer(deferred).color).toBe('blue')
    expect(buttons(deferred)[0]?.disabled).toBe(false)
    expect(buttons(deferred)[1]?.disabled).toBe(false)
    // 二次确认跟着风险级走，与状态无关（拒绝按钮本来就没有确认框，见 §5）。
    expect(buttons(deferred)[0]?.confirm).toBeDefined()
    const deferredText = markdowns(deferred).join('')
    expect(deferredText).toContain('同步窗口内没人应答，已转后台等待审批')
    expect(deferredText).toContain('仍然可以批准')
    // 门关上（`expired`）的那一张仍然置灰 —— 两个状态的区别就在这个字段上。
    expect(buttons(buildApprovalCard(record, { kind: 'expired' }, policy))[0]?.disabled).toBe(true)
  })

  it('只用真应用收得下的构造：第 8 步探针逐候选实测', () => {
    // `.spike/feishu-card-probe.mjs` 对真应用发过十个候选，其中 `action`（200861 unsupported tag）
    // 与 `note` 被拒；把颜色名当组件名写进 text_tag_list 又被拒一次（200621 not support tag: blue）。
    // 这个白名单就是那份实测的落点：以后往卡片里塞一个新构造，先要在真应用上过一遍。
    const verified = new Set(['div', 'button', 'hr', 'markdown'])
    for (const state of [{ kind: 'awaiting' }, { kind: 'reminded' }, { kind: 'deferred', text: '已转后台' }, { kind: 'expired' }] as ApprovalCardState[]) {
      for (const level of ['L1', 'L2', 'L3', 'L4'] as const) {
        const card = buildApprovalCard(request({ requestId: 'req-1', riskLevel: level }), state, policy)
        for (const element of card.body.elements) expect(verified.has(element.tag)).toBe(true)
        expect(footer(card).tag).toBe('text_tag')
        expect(buttons(card)).toHaveLength(2)
      }
    }
  })

  it('长动作描述不夹正文：卡片给全，被夹的是告警标题（见 sweeper 的 120 字）', () => {
    const card = buildApprovalCard(request({ requestId: 'req-1', actionSummary: 'y'.repeat(300) }), { kind: 'awaiting' }, policy)
    expect(markdowns(card)[1]).toContain('y'.repeat(300))
  })
})

describe('按钮回传值闭合到真回调路由', () => {
  const token = 'v-token-1'

  const respond = (harness: Harness) => createApprovalCallbackHandler({
    ledger: harness.ledger,
    tenantId: 'tenant-1',
    verificationToken: () => token,
    approversOf: () => ['ou-alice'],
    now: () => askedAt,
  })

  /** 把卡片里现取的 `action.value` 塞进真信封、现算合法签名。 */
  function envelope(value: unknown, openId: string) {
    const rawBody = JSON.stringify({
      schema: '2.0',
      header: { event_id: 'evt-1', token },
      event: { operator: { open_id: openId }, action: { value } },
    })
    const timestamp = String(askedAt)
    return {
      rawBody,
      timestamp,
      nonce: 'nonce-1',
      signature: feishuCardSignature({ timestamp, nonce: 'nonce-1', token, body: rawBody }),
    }
  }

  it('卡片上批准按钮的 value 原样走真路由 ⇒ approved，核对指纹就是卡片上那 12 位', async () => {
    const harness = await boot()
    const record = request({ requestId: 'req-card' })
    await harness.ledger.create(record)
    const card = buildApprovalCard(record, { kind: 'awaiting' }, policy)

    const response = await respond(harness)(envelope(approveValue(card), 'ou-alice'))
    expect(response).toEqual({
      status: 200,
      body: { toast: { type: 'success', content: '已批准，这个动作会在下一个回合自动执行一次。' } },
    })
    const stored = harness.ledger.get('req-card')!
    expect(stored.status).toBe('approved')
    expect(stored.decidedBy).toBe('ou-alice')
    // 卡片上给人看的那 12 位，与批件里机器要比对的那份指纹同源。
    expect(markdowns(card)[1]).toContain(argsDigest(stored.toolArgs as Record<string, unknown>).slice(0, 12))
  })

  it('卡片上拒绝按钮的 value 同样走通 ⇒ rejected', async () => {
    const harness = await boot()
    const record = request({ requestId: 'req-card' })
    await harness.ledger.create(record)
    const card = buildApprovalCard(record, { kind: 'awaiting' }, policy)

    const response = await respond(harness)(envelope(buttons(card)[1]!.behaviors[0]!.value, 'ou-alice'))
    expect(response).toEqual({
      status: 200,
      body: { toast: { type: 'success', content: '已拒绝，我会把这个结果告诉发起人。' } },
    })
    expect(harness.ledger.get('req-card')?.status).toBe('rejected')
  })

  it('同一个 value 点第二次 ⇒ 不重复执行，卡片侧收到「已经处理过了」', async () => {
    const harness = await boot()
    const record = request({ requestId: 'req-card' })
    await harness.ledger.create(record)
    const card = buildApprovalCard(record, { kind: 'awaiting' }, policy)
    const handler = respond(harness)

    await handler(envelope(approveValue(card), 'ou-alice'))
    const again = await handler(envelope(approveValue(card), 'ou-alice'))
    expect(again.body).toEqual({ toast: { type: 'info', content: '这条审批已经处理过了，不再重复执行。' } })
  })
})

describe('发卡与就地改卡（§3.3）', () => {
  it('send 的 HTTP 形状：POST /im/v1/messages + receive_id_type=open_id + interactive + 确定性 uuid + token', async () => {
    const harness = await boot()
    const { channel, calls } = channelFixture(harness)
    const record = request({ requestId: 'req-1' })
    await harness.ledger.create(record)
    const card = await channel.send(record, new AbortController().signal)

    expect(calls).toHaveLength(1)
    const sent = calls[0]!
    expect(sent.method).toBe('POST')
    expect(sent.path).toBe('/open-apis/im/v1/messages')
    expect(sent.query).toEqual({ receive_id_type: 'open_id' })
    expect(sent.token).toBe('t-1')
    expect(sent.body).toMatchObject({ receive_id: 'ou-alice', msg_type: 'interactive', uuid: cardUuid('req-1', 'push', 'ou-alice') })
    expect(sentCard(sent).schema).toBe('2.0')
    expect(card.cardId).toBe('req-1')
    // 句柄进台账：这是「重启后还改得动那张卡」的唯一依据。
    expect(harness.ledger.cardHandle('req-1')).toEqual({
      requestId: 'req-1', messageIds: ['om-1'], recipientIds: ['ou-alice'], pushedAt,
    })
  })

  it('崩溃重发用同一个 uuid：飞书按 uuid 做请求级去重，同内容同 uuid 只会送达一条', async () => {
    const harness = await boot()
    const { channel, calls } = channelFixture(harness)
    const record = request({ requestId: 'req-1' })
    await harness.ledger.create(record)
    await channel.send(record, new AbortController().signal)
    await channel.send(record, new AbortController().signal)

    const uuids = calls.map(call => (call.body as { uuid: string }).uuid)
    expect(uuids).toEqual([cardUuid('req-1', 'push', 'ou-alice'), cardUuid('req-1', 'push', 'ou-alice')])
  })

  /**
   * 第 8 步真人联调抓到的那个坑，钉成回归测试。
   *
   * 真 requestId 是内核的 `randomUUID()`（36 字符）。旧实现把编号原样拼进 uuid ⇒
   * `office-approval-push-<36>` = 57 字符，飞书在 `POST /im/v1/messages` 上回
   * `99992402 field validation failed` 整条拒绝：**没有任何人收到卡**，而 E13 会把它当成
   * "渠道坏了"交棒给原生面板 —— 也就是说这个坑的表现是"审批看起来还能用"，不是报错。
   * 手工冒烟当时用的是短编号（`smoke-A-040355`，50 字符以内），恰好躲过，所以判据必须是长度而不是"我试过能发"。
   */
  it('uuid 长度钉死 + 逐收件人各异：真 randomUUID 编号也落在飞书收得下的窗口内', () => {
    const realId = 'e8a3260d-bbb1-4e52-aa53-ba2b0414a07b'
    expect(realId).toHaveLength(36)
    for (const attempt of ['push', 'remind'] as const) {
      const uuid = cardUuid(realId, attempt, 'ou-alice')
      expect(uuid.length).toBeLessThanOrEqual(FEISHU_UUID_MAX)
      // 确定性：同一 (编号, 收件人, 用途) 崩溃恢复重发要能被去重窗口吃掉。
      expect(uuid).toBe(cardUuid(realId, attempt, 'ou-alice'))
    }
    // 首推与催办必须不同，否则催办永远发不出去（内容变了却不换 uuid）。
    expect(cardUuid(realId, 'push', 'ou-alice')).not.toBe(cardUuid(realId, 'remind', 'ou-alice'))
    // 不同审批不能共用 uuid，否则第二张卡根本不会送达（E14）。
    expect(cardUuid(realId, 'push', 'ou-alice')).not.toBe(cardUuid('e8a3260d-bbb1-4e52-aa53-ba2b0414a07c', 'push', 'ou-alice'))
    // #31：同一审批、同一用途，**不同收件人必须各一个 uuid** —— 共用一个会被飞书应用级 1 小时去重
    // 吃掉第二个审批人的卡，而 `sent.length>0` 又让这次「送达过」成立（假传输测不到，只能钉函数）。
    expect(cardUuid(realId, 'push', 'ou-alice')).not.toBe(cardUuid(realId, 'push', 'ou-bob'))
    // 长度仍在上限内：收件人是并进摘要，不是拼进拼接串。
    expect(cardUuid(realId, 'push', 'ou-a-very-long-open-id-like-this-one-aaaaaaaaaaaaaaaaaaaaaaaa')).toHaveLength(cardUuid(realId, 'push', 'ou-alice').length)
  })

  it('E14：一个回合里两次提权 ⇒ 两张卡、两个 uuid，第二张不会被去重吃掉', async () => {
    const harness = await boot()
    const { channel, calls } = channelFixture(harness)
    const first = request({ requestId: 'req-1' })
    const second = request({ requestId: 'req-2' })
    await harness.ledger.create(first)
    await harness.ledger.create(second)
    await channel.send(first, new AbortController().signal)
    await channel.send(second, new AbortController().signal)

    // uuid 带 requestId 才有这张卡：飞书按 uuid 去重，两条审批共用一个 uuid 时第二条根本不送达，
    // 而审批人看到的那张卡会替两条审批「答一次」。
    const uuids = calls.map(call => (call.body as { uuid: string }).uuid)
    expect(new Set(uuids).size).toBe(2)
    expect(uuids).toEqual([cardUuid('req-1', 'push', 'ou-alice'), cardUuid('req-2', 'push', 'ou-alice')])
    expect(harness.ledger.cardHandle('req-1')?.messageIds).toEqual(['om-1'])
    expect(harness.ledger.cardHandle('req-2')?.messageIds).toEqual(['om-2'])
  })

  it('每个收件人各一条消息，句柄全记下：改卡逐条 PATCH', async () => {
    const harness = await boot()
    const { channel, calls } = channelFixture(harness, { recipientsOf: () => ['ou-alice', 'ou-bob'] })
    const record = request({ requestId: 'req-1' })
    await harness.ledger.create(record)
    const card = await channel.send(record, new AbortController().signal)

    expect(calls.map(call => (call.body as { receive_id: string }).receive_id)).toEqual(['ou-alice', 'ou-bob'])
    // #31：两个收件人各带**不同** uuid —— 共用一个会被飞书应用级去重吃掉 ou-bob 的卡，
    // 而 ou-alice 成功让这次「送达过」成立，撤卡/改卡只改到那一张。这条在真传输上才会暴露。
    const uuids = calls.map(call => (call.body as { uuid: string }).uuid)
    expect(new Set(uuids).size).toBe(2)
    expect(uuids).toEqual([cardUuid('req-1', 'push', 'ou-alice'), cardUuid('req-1', 'push', 'ou-bob')])
    expect(harness.ledger.cardHandle('req-1')?.messageIds).toEqual(['om-1', 'om-2'])

    await channel.update(card, '已由 ou-alice 批准')
    expect(trace(calls)).toEqual(['POST ou-alice', 'POST ou-bob', 'PATCH om-1', 'PATCH om-2'])
    expect(markdowns(sentCard(calls[2]!))).toContain('已由 ou-alice 批准')
    expect(footer(sentCard(calls[2]!)).text.content).toBe('已决策')
  })

  it('部分收件人失败仍算送达：收到的人手里有卡可改', async () => {
    const harness = await boot()
    const { channel, calls, failures } = channelFixture(harness, {
      recipientsOf: () => ['ou-alice', 'ou-gone'],
      handler: (call, index) => (index === 1 ? api(400, 230002, 'bot has no permission to send to this user') : undefined),
    })
    const record = request({ requestId: 'req-1' })
    await harness.ledger.create(record)
    const card = await channel.send(record, new AbortController().signal)

    expect(harness.ledger.cardHandle('req-1')?.messageIds).toEqual(['om-1'])
    expect(failures.map(failure => failure.path)).toEqual(['/im/v1/messages'])
    expect(failures[0]!.requestId).toBe('req-1')

    await channel.update(card, '已由 ou-alice 批准')
    expect(trace(calls)).toEqual(['POST ou-alice', 'POST ou-gone', 'PATCH om-1'])
    // 改卡不改状态：决策由回调路由落账，渠道只负责把结果画出来。
    expect(harness.ledger.get('req-1')?.status).toBe('pending')
  })

  it('全数失败 ⇒ send 抛出，台账里不留句柄（E13 的交棒信号）', async () => {
    const harness = await boot()
    const { channel, calls, failures } = channelFixture(harness, {
      recipientsOf: () => ['ou-gone', 'ou-gone2'],
      handler: () => api(400, 230002, 'bot has no permission'),
    })
    const record = request({ requestId: 'req-1' })
    await harness.ledger.create(record)

    await expect(channel.send(record, new AbortController().signal)).rejects.toBeInstanceOf(FeishuApiError)
    expect(harness.ledger.cardHandle('req-1')).toBeUndefined()
    expect(calls).toHaveLength(2)
    // 逐个人的失败各自报告；最后那一次抛出才是「一张都没送达」的结论。
    expect(failures).toHaveLength(2)
  })

  it('审批人名单解析不出来，或名单里没人 ⇒ 一次网络调用都不发就失败', async () => {
    for (const recipientsOf of [() => undefined, () => [] as string[]]) {
      const harness = await boot()
      const { channel, calls } = channelFixture(harness, { recipientsOf })
      const record = request({ requestId: 'req-1' })
      await harness.ledger.create(record)
      await expect(channel.send(record, new AbortController().signal)).rejects.toThrow('no recipient resolved for req-1')
      expect(calls).toHaveLength(0)
    }
  })

  it('改卡单条失败不推翻整次操作：其余照改，失败只报告', async () => {
    const harness = await boot()
    const { channel, calls, failures } = channelFixture(harness, {
      recipientsOf: () => ['ou-alice', 'ou-bob'],
      handler: call => (call.method === 'PATCH' && call.path.endsWith('/om-1')
        ? api(400, 230001, 'invalid message id')
        : undefined),
    })
    const record = request({ requestId: 'req-1' })
    await harness.ledger.create(record)
    const card = await channel.send(record, new AbortController().signal)
    await channel.update(card, '已由 ou-alice 批准')

    expect(trace(calls)).toEqual(['POST ou-alice', 'POST ou-bob', 'PATCH om-1', 'PATCH om-2'])
    expect(failures.map(failure => failure.path)).toEqual(['/open-apis/im/v1/messages/om-1'])
  })

  it('句柄活过重启：第二个进程里的改卡打到同一条 message_id', async () => {
    const root = await newRoot()
    const first = await boot({ root })
    const sent = channelFixture(first)
    const record = request({ requestId: 'req-1' })
    await first.ledger.create(record)
    await sent.channel.send(record, new AbortController().signal)

    const second = await boot({ root })
    const reopened = channelFixture(second)
    await reopened.channel.update(clicked('req-1'), '已由 ou-alice 批准')

    expect(second.ledger.cardHandle('req-1')?.messageIds).toEqual(['om-1'])
    expect(trace(reopened.calls)).toEqual(['PATCH om-1'])
  })

  it('没有句柄就改不了卡：抛，而不是安静地另发一张新卡', async () => {
    const harness = await boot()
    const { channel, calls } = channelFixture(harness)
    await harness.ledger.create(request({ requestId: 'req-1' }))
    await expect(channel.update(clicked('req-1'), '已由 ou-alice 批准')).rejects.toThrow('no card handle for req-1')
    expect(calls).toHaveLength(0)
  })

  it('卡片对应的记录消失 ⇒ update 抛，绝不改别人的卡', async () => {
    const harness = await boot()
    const { channel, calls } = channelFixture(harness)
    await expect(channel.update(clicked('req-ghost'), '已由 ou-alice 批准')).rejects.toThrow('record req-ghost vanished')
    expect(calls).toHaveLength(0)
  })

  it('waitForClick 只被 abort 结束：点击由回调路由送进来，渠道自己不制造第二个来源', async () => {
    const harness = await boot()
    const { channel } = channelFixture(harness)
    const record = request({ requestId: 'req-1' })
    await harness.ledger.create(record)
    const controller = new AbortController()
    const card = await channel.send(record, controller.signal)

    const pending = card.waitForClick(controller.signal)
    // 没有外部事件时它永不 resolve —— 这是有意的（§3.6：同一个决定只能有一个赢家）。
    expect(await Promise.race([pending, 'pending'])).toBe('pending')
    controller.abort()
    expect(await pending).toBeUndefined()

    const aborted = new AbortController()
    aborted.abort()
    expect(await card.waitForClick(aborted.signal)).toBeUndefined()
  })

  it('业务码非 0 就是失败：渠道不看 HTTP 状态决定放行', async () => {
    const harness = await boot()
    const { channel, calls } = channelFixture(harness, { handler: () => ({ status: 200, code: 230001, msg: 'invalid param' }) })
    const record = request({ requestId: 'req-1' })
    await harness.ledger.create(record)
    await expect(channel.send(record, new AbortController().signal)).rejects.toThrow('feishu 230001 at /open-apis/im/v1/messages: invalid param')
    expect(calls).toHaveLength(1)
  })
})

describe('催办与过期的渠道动作（§3.5）', () => {
  it('催办重推换 uuid 发新卡，并把旧卡置灰', async () => {
    const harness = await boot()
    const { channel, calls } = channelFixture(harness)
    const record = request({ requestId: 'req-1' })
    await harness.ledger.create(record)
    await channel.send(record, new AbortController().signal)
    await channel.pushReminder(record)

    expect(trace(calls)).toEqual(['POST ou-alice', 'POST ou-alice', 'PATCH om-1'])
    const uuids = calls.map(call => (call.body as { uuid?: string }).uuid)
    // 内容变了就必须换 uuid：同 uuid 在 1 小时窗口内只成功一条，沿用旧 uuid 的催办永远发不出去。
    expect(uuids).toEqual([cardUuid('req-1', 'push', 'ou-alice'), cardUuid('req-1', 'remind', 'ou-alice'), undefined])
    expect(new Set(uuids.slice(0, 2)).size).toBe(2)
    expect(markdowns(sentCard(calls[1]!)).join('')).toContain('唯一一次')

    expect(calls[2]!.path).toBe('/open-apis/im/v1/messages/om-1')
    expect(footer(sentCard(calls[2]!)).text.content).toBe('已取代')
    // 新卡的句柄覆盖旧句柄：下一次改卡改的是屏幕上最新那张。
    expect(harness.ledger.cardHandle('req-1')?.messageIds).toEqual(['om-2'])
  })

  it('催办时没有旧句柄（首推就没送达）也照样推得出去', async () => {
    const harness = await boot()
    const { channel, calls } = channelFixture(harness)
    const record = request({ requestId: 'req-1' })
    await harness.ledger.create(record)
    await channel.pushReminder(record)

    expect(trace(calls)).toEqual(['POST ou-alice'])
    expect((calls[0]!.body as { uuid: string }).uuid).toBe(cardUuid('req-1', 'remind', 'ou-alice'))
  })

  it('过期：就地改卡 + 通知发起人，措辞是「因未获批准已过期」', async () => {
    const harness = await boot()
    const { channel, calls } = channelFixture(harness)
    const record = request({ requestId: 'req-1' })
    await harness.ledger.create(record)
    await channel.send(record, new AbortController().signal)
    await channel.markExpired(record)

    expect(trace(calls)).toEqual(['POST ou-alice', 'PATCH om-1', 'POST ou-boss'])
    expect(footer(sentCard(calls[1]!)).text.content).toBe('已过期')
    expect(buttons(sentCard(calls[1]!))[0]?.disabled).toBe(true)

    const notice = calls[2]!
    expect(notice.query).toEqual({ receive_id_type: 'open_id' })
    // uuid 只断言前缀与长度形状：编号进 uuid 会顶破飞书的长度上限（见上面那条钉长度的用例）。
    expect(notice.body).toMatchObject({ receive_id: 'ou-boss', msg_type: 'text', uuid: expect.stringMatching(/^oa-notice-[0-9a-f]{24}$/) })
    const text = (JSON.parse((notice.body as { content: string }).content) as { text: string }).text
    expect(text).toContain('因未获批准已过期')
    expect(text).toContain('req-1')
    // D4：没有人做过「拒绝」这个决定，措辞不能替它编一个。
    expect(text).not.toContain('拒绝')
  })

  it('从没送达过的审批过期：没有卡可改，发起人的通知仍然要发', async () => {
    const harness = await boot()
    const { channel, calls } = channelFixture(harness)
    const record = request({ requestId: 'req-1' })
    await harness.ledger.create(record)
    await channel.markExpired(record)

    expect(trace(calls)).toEqual(['POST ou-boss'])
    expect((calls[0]!.body as { msg_type: string }).msg_type).toBe('text')
  })

  it('发起人解析不出来 ⇒ 只改卡，不发通知也不抛', async () => {
    const harness = await boot()
    const { channel, calls } = channelFixture(harness, { initiatorOf: () => undefined })
    const record = request({ requestId: 'req-1' })
    await harness.ledger.create(record)
    await channel.send(record, new AbortController().signal)
    await channel.markExpired(record)
    expect(trace(calls)).toEqual(['POST ou-alice', 'PATCH om-1'])
  })

  it('F-E：`defer` 是就地 PATCH，绝不 DELETE —— 转后台那张卡还得能点', async () => {
    const harness = await boot()
    const { channel, calls } = channelFixture(harness)
    const record = request({ requestId: 'req-1' })
    await harness.ledger.create(record)
    const card = await channel.send(record, new AbortController().signal)

    await channel.defer(card, '同步窗口内没人应答，已转后台等待审批')
    expect(trace(calls)).toEqual(['POST ou-alice', 'PATCH om-1'])
    const patched = sentCard(calls[1]!)
    expect(footer(patched).text.content).toBe('待批准 · 转后台')
    expect(buttons(patched)[0]?.disabled).toBe(false)
    expect(markdowns(patched).join('')).toContain('同步窗口内没人应答，已转后台等待审批')
  })

  it('`defer` 没有句柄时照样抛：responder 的「门还开着」判定必须有事实支撑', async () => {
    const harness = await boot()
    const { channel } = channelFixture(harness)
    await harness.ledger.create(request({ requestId: 'req-1' }))
    await expect(channel.defer(clicked('req-1'), '已转后台')).rejects.toThrow('no card handle for req-1')
  })

  it('撤回是删除 + 另发一条文本：删掉的那条消息留不下这句话', async () => {
    const harness = await boot()
    const { channel, calls } = channelFixture(harness, { recipientsOf: () => ['ou-alice', 'ou-bob'] })
    const record = request({ requestId: 'req-1' })
    await harness.ledger.create(record)
    const card = await channel.send(record, new AbortController().signal)
    await channel.recall(card, '这条审批已被发起人撤回')

    expect(trace(calls)).toEqual([
      'POST ou-alice', 'POST ou-bob', 'DELETE om-1', 'DELETE om-2', 'POST ou-alice', 'POST ou-bob',
    ])
    for (const notice of calls.slice(4)) {
      expect(notice.body).toMatchObject({ msg_type: 'text' })
      expect((JSON.parse((notice.body as { content: string }).content) as { text: string }).text).toContain('撤回')
    }
    // #31 的通知侧：两条撤回通知各带不同 uuid —— 共用一个会被飞书应用级去重吃掉第二条，
    // 于是 ou-bob 的卡删了却没收到那句「已撤回」。
    const noticeUuids = calls.slice(4).map(notice => (notice.body as { uuid: string }).uuid)
    expect(new Set(noticeUuids).size).toBe(2)
  })

  it('已撤回/已删除的三个码按「目的已达到」处理；超窗 230009 是真失败，照常抛', async () => {
    expect([...alreadyGoneCodes].sort((a, b) => a - b)).toEqual([230008, 230011, 230110])
    for (const code of alreadyGoneCodes) {
      const harness = await boot()
      const { channel, calls, failures } = channelFixture(harness, {
        handler: call => (call.method === 'DELETE' ? api(400, code, 'message is already recalled') : undefined),
      })
      const record = request({ requestId: 'req-1' })
      await harness.ledger.create(record)
      const card = await channel.send(record, new AbortController().signal)
      await channel.recall(card, '已撤回')

      // 撤回「失败」之后仍然补发了通知：目的达到就不重做，也不报错、不报告。
      expect(trace(calls)).toEqual(['POST ou-alice', 'DELETE om-1', 'POST ou-alice'])
      expect(failures).toHaveLength(0)
    }

    const harness = await boot()
    const { channel, calls } = channelFixture(harness, {
      handler: call => (call.method === 'DELETE' ? api(400, 230009, 'recall window exceeded') : undefined),
    })
    const record = request({ requestId: 'req-1' })
    await harness.ledger.create(record)
    const card = await channel.send(record, new AbortController().signal)
    await expect(channel.recall(card, '已撤回')).rejects.toThrow('feishu 230009')
    // 抛出去就不补发通知：撤回没做到，「已撤回」这句话就是假的。
    expect(trace(calls)).toEqual(['POST ou-alice', 'DELETE om-1'])
  })

  it('通知发不出去不影响撤回与过期：只报告，不二次抛出', async () => {
    const harness = await boot()
    const { channel, calls, failures } = channelFixture(harness, {
      handler: call => ((call.body as { msg_type?: string } | undefined)?.msg_type === 'text'
        ? api(400, 230002, 'bot cannot reach the initiator')
        : undefined),
    })
    const record = request({ requestId: 'req-1' })
    await harness.ledger.create(record)
    await channel.send(record, new AbortController().signal)
    await channel.markExpired(record)

    expect(trace(calls)).toEqual(['POST ou-alice', 'PATCH om-1', 'POST ou-boss'])
    expect(failures.map(failure => failure.path)).toEqual(['/im/v1/messages'])
  })
})

describe('累计放宽次数（§4 策略滑坡）', () => {
  it('只数真正批过的提权审批：拒绝的、还挂着的、不带提权参数的、别的会话的都不算', async () => {
    const harness = await boot()
    const escalatedArgs = { sandbox_permissions: 'danger-full-access' }
    await harness.ledger.create(request({ requestId: 'r-1', status: 'approved', toolArgs: escalatedArgs }))
    await harness.ledger.create(request({ requestId: 'r-2', status: 'consumed', toolArgs: escalatedArgs }))
    await harness.ledger.create(request({ requestId: 'r-3', status: 'rejected', toolArgs: escalatedArgs }))
    await harness.ledger.create(request({ requestId: 'r-4', status: 'pending', toolArgs: escalatedArgs }))
    await harness.ledger.create(request({ requestId: 'r-5', status: 'approved', toolArgs: { file_path: 'inbox.md' } }))
    await harness.ledger.create(request({ requestId: 'r-6', sessionId: 'session-2', status: 'approved', toolArgs: escalatedArgs }))

    // 卡片上的每一个数字都必须是模型看不见、只有账本知道的事实。
    expect(sessionRelaxationCount(harness.ledger)(request({ requestId: 'r-1' }))).toBe(2)
    expect(sessionRelaxationCount(harness.ledger)(request({ requestId: 'r-6', sessionId: 'session-2' }))).toBe(1)
  })

  it('install 的默认策略就是这本账；卡片上的数字由平台给出，不由渠道猜', async () => {
    const harness = await boot()
    const escalatedArgs = { sandbox_permissions: 'danger-full-access' }
    await harness.ledger.create(request({ requestId: 'r-1', status: 'approved', toolArgs: escalatedArgs }))
    await harness.ledger.create(request({ requestId: 'r-2', status: 'approved', toolArgs: escalatedArgs }))
    const feishu = fakeFeishu()
    const installed = installFeishuApprovalChannel({
      transport: feishu.transport,
      tokens: staticTokens(),
      ledger: harness.ledger,
      recipientsOf: () => ['ou-alice'],
      initiatorOf: () => 'ou-boss',
    })
    await installed.send(request({ requestId: 'r-3' }), new AbortController().signal)
    expect(markdowns(sentCard(feishu.calls[0]!)).join('')).toContain('本会话已累计放宽 2 次')

    const overridden = channelFixture(harness, { policy: { relaxationCount: () => 7, repeatAsks: () => 1 } })
    await overridden.channel.send(request({ requestId: 'r-3' }), new AbortController().signal)
    expect(markdowns(sentCard(overridden.calls[0]!)).join('')).toContain('本会话已累计放宽 7 次')
  })
})

describe('同一个动作重复询问（U9）', () => {
  const escalatedArgs = {
    file_path: 'C:\\Users\\demo\\report.docx',
    content: 'SECRET_BODY_TEXT',
    sandbox_permissions: 'danger-full-access',
    justification: 'NOTE-A',
  }

  it('按（同工具 + 同参数指纹）数所有状态，`justification` 改写仍算同一个动作，跨工具/跨会话分开数', async () => {
    const harness = await boot()
    // 同一次写：第一条还挂着、第二条超窗作废 —— 两条都该被认成「同一个动作」，且都不要求批过。
    await harness.ledger.create(request({ requestId: 'r-1', toolArgs: escalatedArgs }))
    await harness.ledger.create(request({ requestId: 'r-2', status: 'expired', toolArgs: { ...escalatedArgs, justification: 'NOTE-B' } }))
    // 指纹不同（另一个文件）与换了工具都不并进同一条计数。
    await harness.ledger.create(request({ requestId: 'r-3', status: 'approved', toolArgs: { ...escalatedArgs, file_path: 'D:\\other.docx' } }))
    await harness.ledger.create(request({ requestId: 'r-4', toolName: 'mail', toolArgs: escalatedArgs }))

    const repeat = sessionRepeatAsks(harness.ledger)
    expect(repeat(request({ requestId: 'r-1', toolArgs: escalatedArgs }))).toBe(2)
    expect(repeat(request({ requestId: 'r-3', status: 'approved', toolArgs: { ...escalatedArgs, file_path: 'D:\\other.docx' } }))).toBe(1)
    expect(repeat(request({ requestId: 'r-4', toolName: 'mail', toolArgs: escalatedArgs }))).toBe(1)
  })

  it('install 的默认策略接上这本账：超窗后重试同一动作的第二张卡自己标出「第 2 次」', async () => {
    const harness = await boot()
    // 第一条：同一个 write 已经超窗作废（没批成），正是 U9 现场里模型 5 秒内重试前挂着的那张。
    await harness.ledger.create(request({ requestId: 'r-old', status: 'expired', toolArgs: escalatedArgs }))
    const feishu = fakeFeishu()
    const installed = installFeishuApprovalChannel({
      transport: feishu.transport,
      tokens: staticTokens(),
      ledger: harness.ledger,
      recipientsOf: () => ['ou-alice'],
      initiatorOf: () => 'ou-boss',
    })
    // 真流程里闸先落 `pending` 快照、responder 才发卡 —— 发卡时这条已在账上，计数才含它自己（顺序照它来）。
    const retry = request({ requestId: 'r-new', toolArgs: { ...escalatedArgs, justification: 'NOTE-C' } })
    await harness.ledger.create(retry)
    await installed.send(retry, new AbortController().signal)
    expect(markdowns(sentCard(feishu.calls[0]!)).join('')).toContain('本会话第 2 次为**同一个动作**请求放宽权限')
  })

  it('首次请求（会话里没有同动作的前例）不渲染重复提示', async () => {
    const harness = await boot()
    const feishu = fakeFeishu()
    const installed = installFeishuApprovalChannel({
      transport: feishu.transport,
      tokens: staticTokens(),
      ledger: harness.ledger,
      recipientsOf: () => ['ou-alice'],
      initiatorOf: () => 'ou-boss',
    })
    await installed.send(request({ requestId: 'r-first', toolArgs: { ...escalatedArgs, file_path: 'C:\\Users\\demo\\fresh.docx' } }), new AbortController().signal)
    expect(markdowns(sentCard(feishu.calls[0]!)).join('')).not.toContain('为**同一个动作**请求放宽权限')
  })
})

describe('tenant_access_token 缓存', () => {
  /** 每次签发给一个新 token，并记下签发那一次调用（授权调用不该带 Authorization）。 */
  function issuing(expire: number, issues: unknown[]): FeishuTransport {
    return async call => {
      issues.push({ body: call.body, token: call.token })
      return { status: 200, code: 0, tenant_access_token: `t-${String(issues.length)}`, expire }
    }
  }

  it('两次调用共用一次签发；并发的一批也只签发一次', async () => {
    const issues: unknown[] = []
    const tokens = createTenantTokenSource(issuing(7200, issues), 'cli_1', 'secret-1')

    const [a, b] = await Promise.all([tokens.token(), tokens.token()])
    expect(a).toBe('t-1')
    expect(b).toBe('t-1')
    expect(await tokens.token()).toBe('t-1')
    expect(issues).toHaveLength(1)
    expect(issues[0]).toEqual({ body: { app_id: 'cli_1', app_secret: 'secret-1' }, token: undefined })
  })

  it('按提前量刷新：卡到零秒才刷会把批准洪峰压在一次签发的抖动上', async () => {
    const issues: unknown[] = []
    let nowValue = 1_000
    const tokens = createTenantTokenSource(issuing(120, issues), 'cli_1', 'secret-1', {
      now: () => nowValue,
      skewMs: 60_000,
    })

    await tokens.token()
    // 剩余 120 秒减掉 60 秒提前量：到 60 秒就该换，而不是 120 秒。
    nowValue = 1_000 + 59_000
    expect(await tokens.token()).toBe('t-1')
    nowValue = 1_000 + 60_001
    expect(await tokens.token()).toBe('t-2')
    expect(issues).toHaveLength(2)
  })

  it('token 过期或失效：清缓存重签一次，第二次带的是新 token', async () => {
    for (const code of [...tokenInvalidCodes]) {
      const issues: unknown[] = []
      const harness = await boot()
      const { channel, calls, failures } = channelFixture(harness, {
        tokens: createTenantTokenSource(issuing(7200, issues), 'cli_1', 'secret-1'),
        handler: (call, index) => (index === 0 ? api(401, code, 'tenant access token is invalid') : undefined),
      })
      const record = request({ requestId: 'req-1' })
      await harness.ledger.create(record)
      await channel.send(record, new AbortController().signal)

      expect(trace(calls)).toEqual(['POST ou-alice', 'POST ou-alice'])
      expect(calls[0]!.token).toBe('t-1')
      expect(calls[1]!.token).toBe('t-2')
      expect(issues).toHaveLength(2)
      // 重签后的成功不是故障：一次都不报告。
      expect(failures).toHaveLength(0)
      expect(harness.ledger.cardHandle('req-1')?.messageIds).toEqual(['om-2'])
    }
  })

  it('第二次仍然失效就抛：重试只有一次，不做无限循环', async () => {
    const issues: unknown[] = []
    const harness = await boot()
    const { channel, calls } = channelFixture(harness, {
      tokens: createTenantTokenSource(issuing(7200, issues), 'cli_1', 'secret-1'),
      handler: () => api(401, 99991663, 'tenant access token is invalid'),
    })
    const record = request({ requestId: 'req-1' })
    await harness.ledger.create(record)

    await expect(channel.send(record, new AbortController().signal)).rejects.toThrow('feishu 99991663')
    expect(calls).toHaveLength(2)
    expect(issues).toHaveLength(2)
  })

  it('签发失败的错误文本里不带 appSecret', async () => {
    const issues: unknown[] = []
    const transport: FeishuTransport = async call => {
      issues.push(call.body)
      return { status: 400, code: 10014, msg: 'app secret invalid' }
    }
    const tokens = createTenantTokenSource(transport, 'cli_1', 'super-secret-value')
    const failure = await tokens.token().then(() => undefined, (error: unknown) => error as Error)

    expect(failure).toBeInstanceOf(FeishuApiError)
    expect(failure?.message).toContain('app secret invalid')
    expect(failure?.message).not.toContain('super-secret-value')
    // 请求体里必须带着它（那是官方要求的入参），错误文本里不能带着它跑。
    expect(issues[0]).toEqual({ app_id: 'cli_1', app_secret: 'super-secret-value' })
  })

  it('签发失败不留缓存：下一次调用重新签发', async () => {
    const issues: unknown[] = []
    let first = true
    const transport: FeishuTransport = async () => {
      issues.push(1)
      if (first) {
        first = false
        return { status: 200, code: 10014, msg: 'app secret invalid' }
      }
      return { status: 200, code: 0, tenant_access_token: 't-ok', expire: 7200 }
    }
    const tokens = createTenantTokenSource(transport, 'cli_1', 'secret-1')
    await expect(tokens.token()).rejects.toBeInstanceOf(FeishuApiError)
    expect(await tokens.token()).toBe('t-ok')
    expect(issues).toHaveLength(2)
  })
})
