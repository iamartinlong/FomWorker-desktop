/**
 * M1 审批回调路由的验收单测（设计 §8 第 4 步：E5 / E6，加 §4 的租户与时间窗、§3.6 的重复回调）。
 *
 * 验签**不 mock**：签名用真的 `feishuCardSignature` 现算，mock 掉的验签等于没测。
 * 「3 秒内必须应答」用永不 resolve 的通知端口来证 —— 响应能回来就说明没被 await 拖住。
 * 台账用真 json 后端；时钟走假时钟（这一步测的是到期与时间窗的判断，不是真定时器）。
 */

import { describe, expect, it } from 'vitest'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import type { KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import {
  createApprovalCallbackHandler,
  feishuCardSignature,
  installApprovalCallbackRoute,
  type CallbackInput,
  type CallbackRouteOptions,
} from './callback-route.ts'
import { argsDigest, type ApprovalLedger, type ApprovalRequestRecord } from './ledger.ts'
import { installApprovalResponder, PendingApprovalWindows, type ApprovalCard, type ApprovalChannel, type ApprovalClick } from './responder.ts'
import { boot, call, escalated, execute, newRoot, type Harness } from './test-harness.ts'

const token = 'v-token-1'
const askedAt = 1_700_000_000_000

/** 一次入站回调。默认签名合法；失败路径自己改 `signature` / `timestamp` / `rawBody`。 */
function callback(requestId: string, decision: 'approve' | 'reject', openId: string, overrides: Partial<CallbackInput> = {}): CallbackInput {
  const rawBody = overrides.rawBody ?? JSON.stringify({
    schema: '2.0',
    header: { event_id: 'evt-1', token, create_time: String(askedAt) },
    event: {
      operator: { open_id: openId },
      action: { value: { requestId, decision } },
      context: { open_message_id: 'om_1' },
    },
  })
  const timestamp = overrides.timestamp ?? String(askedAt)
  const nonce = overrides.nonce ?? 'nonce-1'
  return { rawBody, timestamp, nonce, signature: overrides.signature ?? feishuCardSignature({ timestamp, nonce, token, body: rawBody }) }
}

/** 用给定正文现算一次合法签名（测「正文参与签名」之外的路径时保持验签有效）。 */
function withSignature(body: string, timestamp = String(askedAt), nonce = 'nonce-1'): CallbackInput {
  return { rawBody: body, timestamp, nonce, signature: feishuCardSignature({ timestamp, nonce, token, body }) }
}

function callbackBody(requestId: string, decision: 'approve' | 'reject', openId: string): string {
  return JSON.stringify({
    schema: '2.0',
    header: { event_id: 'evt-1', token },
    event: { operator: { open_id: openId }, action: { value: { requestId, decision } } },
  })
}

/**
 * 一条用例：真组合 boot（带闸）+ 真回调路由 + 假时钟。
 * 返回的 `ledger` 就是闸那本账，回调与 responder 因此共用同一条写链（§3.6 的前提）。
 */
async function harnessWith(options: {
  routeNow?: () => number
  tenantId?: string
  /** 注入验签密钥的**取值时机**（默认给一个真 token）；用来测「环境变量没配 ⇒ 端口拿到空串」那一臂。 */
  verificationToken?: () => string
  approversOf?: CallbackRouteOptions['approversOf']
  onSettled?: CallbackRouteOptions['onSettled']
  onSettledError?: CallbackRouteOptions['onSettledError']
  onAuditError?: CallbackRouteOptions['onAuditError']
  newGrantId?: () => string
  windowMs?: number
  handToWindow?: CallbackRouteOptions['handToWindow']
  backend?: StorageBackend
  answer?: (ctx: Parameters<typeof installApprovalResponder>[0], ledger: ApprovalLedger) => void
} = {}): Promise<{ harness: Harness; respond: (input: CallbackInput) => Promise<{ status: number; body: unknown }> }> {
  const harness = await boot({
    windowMs: options.windowMs ?? 5_000,
    gateNow: () => askedAt,
    ...(options.backend === undefined ? {} : { backend: options.backend }),
    ...(options.answer === undefined ? {} : { answer: options.answer }),
  })
  const respond = createApprovalCallbackHandler({
    ledger: harness.ledger,
    tenantId: options.tenantId ?? 'tenant-1',
    verificationToken: options.verificationToken ?? (() => token),
    approversOf: options.approversOf ?? (record => record.riskLevel === 'L4' ? ['ou-owner'] : ['ou-alice', 'ou-bob']),
    now: options.routeNow ?? (() => askedAt),
    ...(options.handToWindow === undefined ? {} : { handToWindow: options.handToWindow }),
    ...(options.onSettled === undefined ? {} : { onSettled: options.onSettled }),
    ...(options.onSettledError === undefined ? {} : { onSettledError: options.onSettledError }),
    ...(options.onAuditError === undefined ? {} : { onAuditError: options.onAuditError }),
    ...(options.newGrantId === undefined ? {} : { newGrantId: options.newGrantId }),
  })
  return { harness, respond }
}

/** 让闸问一次人并且**不给结局**（回调就是这条询问唯一的结局来源）。 */
async function askGate(harness: Harness, name = 'write', args: Record<string, unknown> = escalated): Promise<string> {
  const index = harness.issued.length
  void execute(harness.ctx, call(name, args))
  await until(() => harness.issued.length > index)
  const requestId = harness.issued[index]!
  // 编号在闸生成记录的那一刻就进了 `issued`，快照还在领域写链上排队 —— 只等前者会读到空台账。
  await until(() => harness.ledger.get(requestId) !== undefined)
  return requestId
}

function rows(table: { entries: () => IterableIterator<[string, unknown]> }): unknown[] {
  return [...table.entries()].map(([, row]) => row)
}

async function until(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the approval flow')
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

/** 只让指定表的写入失败，其余正常（E12 在第 4 步的两个落点）。 */
async function faultRootBackend(table: string): Promise<StorageBackend> {
  const root = await newRoot()
  const base = new JsonStorageBackend(root)
  const fail = () => Promise.reject(new Error('simulated disk failure'))
  return {
    close: () => base.close(),
    kv: {
      open: async (descriptor: KvUnitDescriptor): Promise<KvUnit> => {
        const unit = await (base.kv.open(descriptor) as Promise<KvUnit>)
        return {
          loadAll: () => unit.loadAll(),
          putRecord: (target, key, value) => (target === table ? fail() : unit.putRecord(target, key, value)),
          deleteRecord: (target, key) => unit.deleteRecord(target, key),
          setGlobal: value => unit.setGlobal(value),
          close: () => unit.close(),
        }
      },
    },
  }
}

describe('callback-route：验签（E6）', () => {
  it('签名不对 → 401，台账、审计、授权一行都不动', async () => {
    const { harness, respond } = await harnessWith()
    const requestId = await askGate(harness)
    const result = await respond(callback(requestId, 'approve', 'ou-alice', { signature: '0'.repeat(40) }))

    expect(result).toEqual({ status: 401, body: { code: 'signature-mismatch' } })
    expect(harness.ledger.get(requestId)!.status).toBe('pending')
    expect(rows(harness.ledger.denials)).toEqual([])
    expect(rows(harness.ledger.grants)).toEqual([])
  })

  it('Verification Token 没配 ⇒ 用空串现算的「合法」签名一律 401，台账一行不动', async () => {
    // 环境变量缺失时装配交给端口的就是空串。签名方案是公开的（`sha1(timestamp + nonce + token + body)`），
    // token 为空 ⇒ 任何能打到这个端口的人都能自己算出一个「验得过」的签名，把一条在逃的审批批掉；
    // 而 `constantTimeEquals` 对两个空串返回 true，连 `url_verification` 都会白放行。
    // 所以「配置缺失」必须整体拒，而不是照常比对 —— 本项目的登记前提是回调的真实性**只能**靠签名。
    const { harness, respond } = await harnessWith({ verificationToken: () => '' })
    const requestId = await askGate(harness)
    const rawBody = callbackBody(requestId, 'approve', 'ou-alice')
    const timestamp = String(askedAt)
    const forged: CallbackInput = {
      rawBody,
      timestamp,
      nonce: 'nonce-1',
      signature: feishuCardSignature({ timestamp, nonce: 'nonce-1', token: '', body: rawBody }),
    }

    expect(await respond(forged)).toEqual({ status: 401, body: { code: 'verification-token-unset' } })
    expect(harness.ledger.get(requestId)!.status).toBe('pending')
    expect(rows(harness.ledger.grants)).toEqual([])
  })

  it('Verification Token 没配 ⇒ url_verification 不回显 challenge（body 里的 token 同为空串）', async () => {
    const { respond } = await harnessWith({ verificationToken: () => '' })
    expect(await respond({ rawBody: JSON.stringify({ type: 'url_verification', challenge: 'ch-1', token: '' }) }))
      .toEqual({ status: 401, body: { code: 'verification-token-unset' } })
  })

  it('决策请求不带签名头 → 401（只有配置地址时的 url_verification 允许）', async () => {
    const { harness, respond } = await harnessWith()
    const requestId = await askGate(harness)
    expect(await respond({ rawBody: callbackBody(requestId, 'approve', 'ou-alice') }))
      .toEqual({ status: 401, body: { code: 'missing-signature' } })
  })

  it('时间戳过期、来自未来、或根本不是数字 → 都是 bad-timestamp', async () => {
    const { harness, respond } = await harnessWith()
    const requestId = await askGate(harness)
    const stale = callback(requestId, 'approve', 'ou-alice', { timestamp: String(askedAt - 6 * 60_000) })
    const future = callback(requestId, 'approve', 'ou-alice', { timestamp: String(askedAt + 6 * 60_000) })
    expect((await respond(stale)).body).toEqual({ code: 'bad-timestamp' })
    expect((await respond(future)).body).toEqual({ code: 'bad-timestamp' })
    expect((await respond(callback(requestId, 'approve', 'ou-alice', { timestamp: 'not-a-number' }))).body)
      .toEqual({ code: 'bad-timestamp' })
  })

  it('偷到一个合法回调再改编号：正文参与签名，改一个字节就失效', async () => {
    const { harness, respond } = await harnessWith()
    const requestId = await askGate(harness)
    const original = callback(requestId, 'approve', 'ou-alice')
    // 攻击者唯一能做的事：拿一条真回调的签名，配一份改过正文的请求
    const tampered: CallbackInput = {
      rawBody: callbackBody(`${requestId}9`, 'approve', 'ou-alice'),
      timestamp: original.timestamp,
      nonce: original.nonce,
      signature: original.signature,
    }
    expect((await respond(tampered)).body).toEqual({ code: 'signature-mismatch' })
  })

  it('正文不是 JSON：验签没过是 401，过了才是 400', async () => {
    const { respond } = await harnessWith()
    expect(await respond({ rawBody: 'not json', timestamp: String(askedAt), nonce: 'n', signature: 'deadbeef' }))
      .toEqual({ status: 401, body: { code: 'signature-mismatch' } })
    expect(await respond(withSignature('not json'))).toEqual({ status: 400, body: { code: 'malformed-json' } })
  })

  it('url_verification：不带签名头时靠 body 里的 token 判定，比错就 401', async () => {
    const { respond } = await harnessWith()
    expect(await respond({ rawBody: JSON.stringify({ type: 'url_verification', challenge: 'ch-1', token }) }))
      .toEqual({ status: 200, body: { challenge: 'ch-1' } })
    expect(await respond({ rawBody: JSON.stringify({ type: 'url_verification', challenge: 'ch-2', token: 'wrong' }) }))
      .toEqual({ status: 401, body: { code: 'missing-signature' } })
  })
})

describe('callback-route：谁能批（E5）', () => {
  it('非审批人点击 → 状态不动、不放行，但尝试者落审计', async () => {
    const settled: unknown[] = []
    const { harness, respond } = await harnessWith({ approversOf: () => ['ou-alice'], onSettled: event => { settled.push(event) } })
    const requestId = await askGate(harness)

    expect((await respond(callback(requestId, 'approve', 'ou-stranger'))).status).toBe(200)
    const record = harness.ledger.get(requestId)!
    expect(record.status).toBe('pending')
    expect(record.decidedBy).toBeNull()
    expect(rows(harness.ledger.grants)).toEqual([])
    expect(settled).toEqual([])
    expect(rows(harness.ledger.denials)).toMatchObject([{ requestId, openId: 'ou-stranger', tenantId: 'tenant-1', reason: 'not-approver', at: askedAt }])
  })

  it('名单解析不出来 → 一样是拒，审计写明是名单的问题', async () => {
    const { harness, respond } = await harnessWith({ approversOf: () => undefined })
    const requestId = await askGate(harness)
    await respond(callback(requestId, 'approve', 'ou-alice'))
    expect(harness.ledger.get(requestId)!.status).toBe('pending')
    expect(rows(harness.ledger.denials)).toMatchObject([{ reason: 'approvers-unresolvable' }])
  })

  it('L4 只认 owner：同一个人在 L3 能批，在 L4 不能', async () => {
    const { harness, respond } = await harnessWith()
    const requestId = await askGate(harness, 'mail', { to: 'all@corp.example' })
    expect(harness.ledger.get(requestId)!.riskLevel).toBe('L4')

    await respond(callback(requestId, 'approve', 'ou-alice'))
    expect(harness.ledger.get(requestId)!.status).toBe('pending')
    expect((await respond(callback(requestId, 'approve', 'ou-owner', { nonce: 'nonce-2' }))).status).toBe(200)
    expect(harness.ledger.get(requestId)).toMatchObject({ status: 'approved', decidedBy: 'ou-owner' })
  })

  it('记录属于别的租户 → 拒 + 审计，绝不替别的租户落决定', async () => {
    const { harness, respond } = await harnessWith({ tenantId: 'tenant-2' })
    const requestId = await askGate(harness)
    await respond(callback(requestId, 'approve', 'ou-alice'))
    expect(harness.ledger.get(requestId)!.status).toBe('pending')
    expect(rows(harness.ledger.denials)).toMatchObject([{ reason: 'tenant-mismatch' }])
  })

  it('编号对不上任何记录 → 中性回复，什么都不写', async () => {
    const { respond } = await harnessWith()
    expect((await respond(callback('req-never-issued', 'approve', 'ou-alice'))).status).toBe(200)
  })

  it('过了 expiresAt 的批准作废（§3.5 安全阀），且不污染审计流', async () => {
    let clock = askedAt
    const { harness, respond } = await harnessWith({ routeNow: () => clock })
    const requestId = await askGate(harness)
    // 一条真迟到的点击：IM 用的是它自己的当下时间，所以时间戳仍在容差内 —— 挡住它的是
    // expiresAt 这道安全阀，不是重放窗。用同一个 harness 才证得了这条记录本身的状态没动。
    clock = harness.ledger.get(requestId)!.expiresAt + 1
    const input = callback(requestId, 'approve', 'ou-alice', { timestamp: String(clock) })
    expect((await respond(input)).status).toBe(200)
    expect(harness.ledger.get(requestId)!.status).toBe('pending')
    expect(rows(harness.ledger.denials)).toEqual([])
  })

  it('按钮没带审批编号 → 验签有效也不落账', async () => {
    const { harness, respond } = await harnessWith()
    const requestId = await askGate(harness)
    const body = JSON.stringify({ event: { operator: { open_id: 'ou-alice' }, action: { value: { note: '随手点的' } } } })
    expect((await respond(withSignature(body))).status).toBe(200)
    expect(harness.ledger.get(requestId)!.status).toBe('pending')
    expect(rows(harness.ledger.denials)).toEqual([])
  })
})

describe('callback-route：落账与通知（§3.6 + 3 秒窗口）', () => {
  it('审批人点同意 → approved + 一次性 grant，指纹取自闸落的参数', async () => {
    const settled: { record: ApprovalRequestRecord; decision: string; grantId?: string }[] = []
    const { harness, respond } = await harnessWith({ newGrantId: () => 'g-1', onSettled: event => { settled.push(event) } })
    const requestId = await askGate(harness)

    expect((await respond(callback(requestId, 'approve', 'ou-alice'))).status).toBe(200)
    const record = harness.ledger.get(requestId)!
    expect(record).toMatchObject({ status: 'approved', decidedBy: 'ou-alice', decidedAt: askedAt })
    expect(rows(harness.ledger.grants)).toMatchObject([{ grantId: 'g-1', toolName: 'write', consumes: 1, grantExpiresAt: record.expiresAt }])
    // 指纹必须与 responder 重放时现算的那个一致（§3.4.1①：justification 不参与）
    expect((rows(harness.ledger.grants)[0] as { argsDigest: string }).argsDigest).toBe(argsDigest(escalated))
    expect(settled).toHaveLength(1)
    // 通知拿到的是迁移之后的记录
    expect(settled[0]!.record.status).toBe('approved')
    expect(settled[0]!.grantId).toBe('g-1')
  })

  it('同一个编号回调两次（IM 重投 / 用户连点）→ 第二次 CAS 失败，grant 仍只有一张', async () => {
    const settled: unknown[] = []
    let serial = 0
    const { harness, respond } = await harnessWith({ newGrantId: () => `g-${++serial}`, onSettled: event => { settled.push(event) } })
    const requestId = await askGate(harness)

    await respond(callback(requestId, 'approve', 'ou-alice'))
    const second = await respond(callback(requestId, 'approve', 'ou-alice', { nonce: 'nonce-2' }))
    expect((second.body as { toast: { type: string } }).toast.type).toBe('info')
    expect(rows(harness.ledger.grants)).toHaveLength(1)
    expect(settled).toHaveLength(1)
  })

  it('批准之后迟到的拒绝推翻不了已落的决定（审批人改了主意，但授权已经发出）', async () => {
    const settled: { decision: string }[] = []
    const { harness, respond } = await harnessWith({ onSettled: event => { settled.push(event) } })
    const requestId = await askGate(harness)

    await respond(callback(requestId, 'approve', 'ou-alice'))
    // 点拒绝的是名单里的另一个人 —— 挡住它的必须是 CAS，不是「你没资格」
    const late = await respond(callback(requestId, 'reject', 'ou-bob', { nonce: 'nonce-2' }))
    expect((late.body as { toast: { type: string } }).toast.type).toBe('info')
    expect(harness.ledger.get(requestId)).toMatchObject({ status: 'approved', decidedBy: 'ou-alice' })
    expect(rows(harness.ledger.grants)).toHaveLength(1)
    expect(settled.map(event => event.decision)).toEqual(['approve'])
  })

  it('点拒绝 → rejected、不放行、不生成授权，但仍要通知（模型得知道别再重试）', async () => {
    const settled: { decision: string }[] = []
    const { harness, respond } = await harnessWith({ onSettled: event => { settled.push(event) } })
    const requestId = await askGate(harness)

    await respond(callback(requestId, 'reject', 'ou-bob'))
    expect(harness.ledger.get(requestId)!.status).toBe('rejected')
    expect(rows(harness.ledger.grants)).toEqual([])
    expect(settled).toEqual([{ record: expect.objectContaining({ status: 'rejected' }), decision: 'reject' }])
  })

  it('通知永不 resolve 也拦不住响应（飞书要求 3 秒内 200）', async () => {
    const { harness, respond } = await harnessWith({ onSettled: () => new Promise<never>(() => {}) })
    const requestId = await askGate(harness)
    const raced = await Promise.race([
      respond(callback(requestId, 'approve', 'ou-alice')),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 500)),
    ])
    expect(raced).not.toBeNull()
    expect((raced as { status: number }).status).toBe(200)
    // 批准确实落了账 —— 不是靠提前返回蒙过去的
    expect(harness.ledger.get(requestId)!.status).toBe('approved')
  })

  it('通知抛错不冒泡给 IM，但要交给错误去处', async () => {
    const errors: unknown[] = []
    const { harness, respond } = await harnessWith({
      onSettled: () => { throw new Error('followup blew up') },
      onSettledError: error => { errors.push(error) },
    })
    const requestId = await askGate(harness)
    expect((await respond(callback(requestId, 'approve', 'ou-alice'))).status).toBe(200)
    await until(() => errors.length === 1)
    expect(errors[0]).toBeInstanceOf(Error)
  })

  it('grant 写不下去时绝不报「已批准」（approve 已补偿回 expired，重点一次即成）', async () => {
    const backend = await faultRootBackend('grants')
    const { harness, respond } = await harnessWith({ backend })
    const requestId = await askGate(harness)
    const result = await respond(callback(requestId, 'approve', 'ou-alice'))
    expect((result.body as { toast: { content: string } }).toast.content).toContain('没能落账')
    expect(harness.ledger.get(requestId)!.status).toBe('expired')
    expect(rows(harness.ledger.grants)).toEqual([])
  })

  it('审计写不下去时拒依然成立，但错误必须交出去', async () => {
    const backend = await faultRootBackend('denials')
    const errors: unknown[] = []
    const { harness, respond } = await harnessWith({ backend, approversOf: () => ['ou-alice'], onAuditError: error => { errors.push(error) } })
    const requestId = await askGate(harness)
    expect((await respond(callback(requestId, 'approve', 'ou-stranger'))).status).toBe(200)
    expect(harness.ledger.get(requestId)!.status).toBe('pending')
    expect(errors).toHaveLength(1)
  })
})

describe('callback-route：与同步窗口共用一本账', () => {
  it('回调先落账，窗口里那张卡的晚到点击推翻不了它', async () => {
    const cards = terminalChannel()
    const { harness, respond } = await harnessWith({
      answer: (ctx, ledger) => { installApprovalResponder(ctx, { ledger, channel: cards.channel, now: () => askedAt }) },
    })
    const target = call('write', escalated)
    const pending = execute(harness.ctx, target)
    await until(() => cards.sent.length === 1)

    expect((await respond(callback('req-gate-1', 'approve', 'ou-alice'))).status).toBe(200)
    // 同步窗口还开着，卡片也还挂着 —— 用户在网页面板上补点一个「拒绝」
    cards.sent[0]!.card.click('reject', 'ou-bob')
    expect((await pending).isError).toBe(false)
    expect(harness.ledger.get('req-gate-1')).toMatchObject({ status: 'approved', decidedBy: 'ou-alice' })
    // 决定不是这张卡做出来的，responder 就不去改这张卡 —— 卡片归渠道所有，改它需要赢下 CAS
    expect(cards.updates).toEqual([])
    // 这一轮执行来自 CAS 收敛（读到已落账的批准），不是来自点击
    expect(harness.calls.write).toHaveLength(1)
  })

  it('真实瀑布顺序（U7）：面板先挂载，`prepend` 的 responder 仍然先被问到', async () => {
    const asked: string[] = []
    const cards = terminalChannel()
    const { harness } = await harnessWith({
      answer: (ctx, ledger) => {
        // 产品里 Web UI 自带面板确实先挂载（内核插件早于 patch 插件），顺序照它来
        ctx.on('approval/request', () => { asked.push('panel'); return Promise.resolve<ApprovalOutcome>('allowed-once') })
        installApprovalResponder(ctx, { ledger, channel: cards.channel, now: () => askedAt })
      },
    })
    void execute(harness.ctx, call('write', escalated))
    await until(() => cards.sent.length === 1)
    // 没有 prepend 就会被面板抢先 —— 这条断言正是第 3 步活下来的那条变异现在要挡住的
    expect(asked).toEqual([])
    cards.sent[0]!.card.click('approve', 'ou-alice')
    await until(() => harness.ledger.get('req-gate-1')!.status === 'approved')
  })
})

describe('callback-route：窗口内批准的一致性（U10）', () => {
  it('活窗口接住批准 → 不发放批件、不通知恢复路径、记录仍待 responder 迁、toast 说当前回合', async () => {
    const settled: unknown[] = []
    const handoffs: { requestId: string; decision: string; openId: string }[] = []
    const { harness, respond } = await harnessWith({
      onSettled: event => { settled.push(event) },
      handToWindow: (requestId, handoff) => { handoffs.push({ requestId, ...handoff }); return true },
    })
    const requestId = await askGate(harness)

    const result = await respond(callback(requestId, 'approve', 'ou-alice'))
    // 交回窗口 = 这次调用这一轮执行，responder 才是落状态的人：路由既不落批件、也不抢先迁状态。
    expect(handoffs).toEqual([{ requestId, decision: 'approve', openId: 'ou-alice' }])
    expect(rows(harness.ledger.grants)).toEqual([])          // §3.4.2 毫秒存在期：批件根本没发出去
    expect(settled).toEqual([])                              // 没有要唤醒的会话 → 不通知恢复路径
    expect(harness.ledger.get(requestId)!.status).toBe('pending')  // 状态迁移归赢下 CAS 的 responder
    // toast 按交付路径分支：说的是「当前回合」，不再是自相矛盾的「下一个回合自动执行」。
    expect((result.body as { toast: { content: string } }).toast.content).toContain('当前回合')
  })

  it('没有活窗口 → 落批件 + 通知恢复路径，toast 回到「下一个回合」那条', async () => {
    const settled: unknown[] = []
    const { harness, respond } = await harnessWith({
      newGrantId: () => 'g-1',
      onSettled: event => { settled.push(event) },
      handToWindow: () => false,
    })
    const requestId = await askGate(harness)

    const result = await respond(callback(requestId, 'approve', 'ou-alice'))
    expect(harness.ledger.get(requestId)!.status).toBe('approved')
    expect(rows(harness.ledger.grants)).toMatchObject([{ grantId: 'g-1' }])
    expect(settled).toHaveLength(1)
    expect((result.body as { toast: { content: string } }).toast.content).toContain('下一个回合')
  })

  it('活窗口接住拒绝 → 交回 responder 落状态并置灰，路由不抢先迁（同一把仲裁，拒绝也走窗口优先）', async () => {
    const handoffs: string[] = []
    const { harness, respond } = await harnessWith({
      handToWindow: (requestId, handoff) => { handoffs.push(`${handoff.decision}:${handoff.openId}`); return true },
    })
    const requestId = await askGate(harness)
    await respond(callback(requestId, 'reject', 'ou-bob'))
    expect(handoffs).toEqual(['reject:ou-bob'])
    expect(harness.ledger.get(requestId)!.status).toBe('pending')  // 交给 responder 去迁 rejected
  })

  it('端到端：一次经回调进来的窗口内批准 —— 卡片置灰、只执行一次、台账零批件', async () => {
    const cards = terminalChannel()
    const windows = new PendingApprovalWindows()
    const harness = await boot({
      windowMs: 5_000,
      gateNow: () => askedAt,
      answer: (ctx, ledger) => { installApprovalResponder(ctx, { ledger, channel: cards.channel, windows, now: () => askedAt }) },
    })
    const respond = createApprovalCallbackHandler({
      ledger: harness.ledger,
      tenantId: 'tenant-1',
      verificationToken: () => token,
      approversOf: record => (record.riskLevel === 'L4' ? ['ou-owner'] : ['ou-alice', 'ou-bob']),
      now: () => askedAt,
      handToWindow: (requestId, handoff) => windows.settle(requestId, handoff),
    })

    const pending = execute(harness.ctx, call('write', escalated))
    await until(() => cards.sent.length === 1)
    const requestId = harness.issued[0]!

    const result = await respond(callback(requestId, 'approve', 'ou-alice'))
    expect((result.body as { toast: { content: string } }).toast.content).toContain('当前回合')

    const outcome = await pending
    expect(outcome.isError).toBe(false)
    expect(harness.calls.write).toHaveLength(1)                    // 执行恰好一次
    expect(harness.ledger.get(requestId)).toMatchObject({ status: 'approved', decidedBy: 'ou-alice' })
    expect(rows(harness.ledger.grants)).toEqual([])               // 这条路不落批件 → 没有存在期、没有事后收回
    // 卡片由赢下 CAS 的 responder 就地置灰（U10 现场里那个「按钮还亮着」被这条钉子关掉）。
    expect(cards.updates).toEqual([expect.stringContaining('批准')])
  })
})

describe('callback-route：HTTP 接线（webServer）', () => {
  it('注册成 exact 路由：先读原文再验签，GET 与超限都不进决策路径', async () => {
    const harness = await boot({ windowMs: 5_000, gateNow: () => askedAt })
    const requestId = await askGate(harness)
    const registered: { kind: string; path: string; handler: Handler }[] = []
    harness.ctx.provide('webServer', {
      register: (route: { kind: 'exact'; path: string; handler: Handler }) => {
        registered.push(route as { kind: 'exact'; path: string; handler: Handler })
        return () => {}
      },
    } as never)
    installApprovalCallbackRoute(harness.ctx, {
      ledger: harness.ledger,
      tenantId: 'tenant-1',
      verificationToken: () => token,
      approversOf: () => ['ou-alice', 'ou-bob'],
      now: () => askedAt,
    })
    expect(registered).toHaveLength(1)
    expect(registered[0]).toMatchObject({ kind: 'exact', path: '/office/approval/callback' })

    const get = capture()
    await registered[0]!.handler(fakeRequest('GET', ''), get.res as never)
    expect(get.statusCode()).toBe(405)

    const big = capture()
    await registered[0]!.handler(fakeRequest('POST', 'x'.repeat(70 * 1024)), big.res as never)
    expect(big.statusCode()).toBe(413)
    expect(harness.ledger.get(requestId)!.status).toBe('pending')

    const input = callback(requestId, 'approve', 'ou-alice')
    const ok = capture()
    await registered[0]!.handler(fakeRequest('POST', input.rawBody, {
      'x-lark-request-timestamp': input.timestamp,
      'x-lark-request-nonce': input.nonce,
      'x-lark-signature': input.signature,
    }), ok.res as never)
    expect(ok.statusCode()).toBe(200)
    expect(harness.ledger.get(requestId)!.status).toBe('approved')
  })
})

type Handler = (request: unknown, response: unknown) => void | Promise<void>

function fakeRequest(method: string, body: string, headers: Record<string, string | undefined> = {}) {
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body.length > 0) yield Buffer.from(body, 'utf8')
    },
  }
}

function capture() {
  const state = { statusCode: 0, chunks: [] as string[] }
  const res = {
    writeHead(status: number) { state.statusCode = status },
    end(chunk?: string) { if (chunk !== undefined) state.chunks.push(chunk) },
  }
  return { res, statusCode: () => state.statusCode }
}

class TerminalCard implements ApprovalCard {
  readonly cardId: string
  private settled = false
  private resolver: ((click: ApprovalClick | undefined) => void) | undefined
  private readonly pending: Promise<ApprovalClick | undefined>

  constructor(cardId: string, signal: AbortSignal) {
    this.cardId = cardId
    this.pending = new Promise(resolve => { this.resolver = resolve })
    signal.addEventListener('abort', () => this.settle(undefined), { once: true })
  }

  waitForClick(): Promise<ApprovalClick | undefined> {
    return this.pending
  }

  click(decision: ApprovalClick['decision'], openId: string): void {
    this.settle({ decision, openId })
  }

  private settle(click: ApprovalClick | undefined): void {
    if (this.settled) return
    this.settled = true
    this.resolver?.(click)
  }
}

function terminalChannel(): {
  channel: ApprovalChannel
  sent: { record: ApprovalRequestRecord; card: TerminalCard }[]
  updates: string[]
} {
  const sent: { record: ApprovalRequestRecord; card: TerminalCard }[] = []
  const updates: string[] = []
  return {
    sent,
    updates,
    channel: {
      send: async (record, signal) => {
        const card = new TerminalCard(`card-${sent.length + 1}`, signal)
        sent.push({ record, card })
        return card
      },
      update: async (_card, text) => { updates.push(text) },
      defer: async () => {},
      recall: async () => {},
    },
  }
}
