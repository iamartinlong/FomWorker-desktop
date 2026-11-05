/**
 * M1 审批回调路由（设计 §4「谁能批」「回调真实性」、§3.6 并发正确性；§8 第 4 步）。
 *
 * 两条外部事实决定它的形状：
 * - 飞书要求卡片回传在 **3 秒内以 HTTP 200 应答**，所以「批准之后叫醒会话」绝不能排在响应前面 ——
 *   本步只落账，唤醒走不 await 的端口（第 5 步接 `followup`，第 6 步接卡片回执）。
 * - 内核没有审批人概念（F4）：「这个 `open_id` 能不能批这条」100% 是平台的判断，
 *   解析不出来时必须拒（fail-closed），不能因为查不到名单就当它是 owner。
 *
 * 挂载经 `ctx.webServer.register`，与内核自己的 `packages/webhook/webhook-github` 同形；
 * 那条路由**不在 dsh 的 token 守卫之内**（守卫在 `client/connection` 的 `/api` 里），
 * 所以真实性只能靠签名 —— 见 `authenticate`。
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { argsDigest, type ApprovalLedger, type ApprovalRequestRecord, type DenialRecord, type GrantRecord } from './ledger.ts'

/** 决策动作，来自卡片按钮自带的 `action.value`（第 6 步发卡时必须嵌入这个形状）。 */
export interface ApprovalCardValue {
  readonly requestId: string
  readonly decision: 'approve' | 'reject'
}

/** 一次入站回调：`rawBody` 必须是**未经解析**的原文，签名算的就是这几个字节。 */
export interface CallbackInput {
  readonly rawBody: string
  readonly timestamp?: string | undefined
  readonly nonce?: string | undefined
  readonly signature?: string | undefined
}

export interface CallbackResponse {
  readonly status: number
  readonly body: unknown
}

/** 落账成功之后要通知的事（第 5 步的唤醒 / 第 6 步的卡片回执）。 */
export interface ApprovalSettled {
  readonly record: ApprovalRequestRecord
  readonly decision: ApprovalCardValue['decision']
  readonly grantId?: string | undefined
}

/**
 * 交给同步窗口的一次决策 —— 与 responder 的 `ApprovalClick` 同形，但这里**不 import responder**
 * （路由不该焊在裁决者上），所以自带这份最小形状。
 */
export interface WindowHandoff {
  readonly decision: ApprovalCardValue['decision']
  readonly openId: string
}

export interface CallbackRouteOptions {
  ledger: ApprovalLedger
  /** 这个回调地址属于哪个租户；记录不属它就不该经这个入口落账。 */
  tenantId: string
  /** 飞书应用的 Verification Token（签名串里的第三段）。 */
  verificationToken: () => string
  /**
   * 这条记录的审批人集合。`undefined` = 名单解析不出来 → 拒（§4）；
   * 空数组 = 有名单但没人在里面 → 拒。L4「仅 owner 可批」由实现方在此收敛。
   */
  approversOf: (record: ApprovalRequestRecord) => readonly string[] | undefined
  /** 时间戳容差；飞书没规定，取 webhook 通用的 5 分钟。 */
  toleranceMs?: number | undefined
  now?: () => number
  newDenialId?: () => string
  newGrantId?: () => string
  /** 落账后的通知。**路由绝不 await 它**（3 秒窗口）。 */
  onSettled?: (event: ApprovalSettled) => void | Promise<void>
  /**
   * 落账**之前**先看有没有一个还在等的同步窗口：有就把这次点击当场交回它，返回 true。
   *
   * U10 的机制。窗口还活着 = 那次在飞的调用这一轮就执行，于是这条路**不发批件、也不需要事后收回**
   * —— §3.4.2 那条「批件从落账到收回」的毫秒级存在期从结构上消失；卡片置灰由接住点击的 responder 做
   * （它赢下 `pending→approved` 那次 CAS）。返回 false 才落状态 + 批件，交给唤醒重放。
   * 必须**同步**返回，不得 await（飞书 3 秒义务）。缺省（CLI / 没有窗口装配的单测）按 false 处理，
   * 于是行为退回「总是落批件 + 通知」那条老路。
   */
  handToWindow?: (requestId: string, handoff: WindowHandoff) => boolean
  /** 通知失败的去处 —— 不能让 IM 等，也不能把错误吞掉。 */
  onSettledError?: (error: unknown, event: ApprovalSettled) => void
  /** 审计行写不下去的去处（越权尝试必须告警，不能静默）。 */
  onAuditError?: (error: unknown, denial: DenialRecord) => void
}

export const defaultToleranceMs = 5 * 60_000

/** 回调正文上限：审批卡片带不动更大的东西，超了直接拒读，不给解析器机会。 */
export const defaultMaxBodyBytes = 64 * 1024

/**
 * 飞书卡片回调签名：`sha1(timestamp + nonce + Verification Token + body)` 的十六进制。
 * 官方明确**只用 Verification Token，不支持 Encrypt Key** 做这件事，所以这里没有 AES。
 */
export function feishuCardSignature(parts: {
  timestamp: string
  nonce: string
  token: string
  body: string
}): string {
  return createHash('sha1').update(`${parts.timestamp}${parts.nonce}${parts.token}${parts.body}`, 'utf8').digest('hex')
}

/** 等长再比，常量时间 —— 与内核 `deepseek-account-platform` 的比法一致。 */
function constantTimeEquals(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  if (a.byteLength !== b.byteLength) return false
  return timingSafeEqual(a, b)
}

const cardValueSchema = z.object({
  requestId: z.string().min(1),
  decision: z.enum(['approve', 'reject']),
})

/**
 * 只声明我们真要用的字段：飞书信封还有 `schema`、`header.event_id`、`event.context` 等等，
 * 全量建模等于把路由焊在某个 IM 的字段表上。未声明的键在 zod 默认被剥掉，不影响解析。
 */
const cardCallbackSchema = z.object({
  event: z.object({
    operator: z.object({ open_id: z.string().min(1) }),
    action: z.object({ value: z.unknown() }),
  }),
})

const challengeSchema = z.object({
  type: z.literal('url_verification'),
  challenge: z.string().min(1),
  token: z.string().optional(),
})

/** 验签失败原因（也是响应体的 `code`）；措辞不给任何「差多少」的线索。 */
type AuthFailure = 'missing-signature' | 'bad-timestamp' | 'signature-mismatch'

export function createApprovalCallbackHandler(options: CallbackRouteOptions) {
  const now = options.now ?? (() => Date.now())
  const toleranceMs = options.toleranceMs ?? defaultToleranceMs
  const newDenialId = options.newDenialId ?? (() => randomUUID())
  const newGrantId = options.newGrantId ?? (() => randomUUID())
  const { ledger } = options

  /** 验签：时间窗在前，签名比对在后；两条都不写台账（E6）。 */
  function authenticate(input: {
    rawBody: string
    timestamp: string
    nonce: string
    signature: string
  }): AuthFailure | undefined {
    const sentAt = Number(input.timestamp)
    if (!Number.isFinite(sentAt)) return 'bad-timestamp'
    // 双向判：只判「不早于」会放过一个未来的时间戳，重放窗口等于无限。
    if (Math.abs(now() - sentAt) > toleranceMs) return 'bad-timestamp'
    const expected = feishuCardSignature({
      timestamp: input.timestamp,
      nonce: input.nonce,
      token: options.verificationToken(),
      body: input.rawBody,
    })
    return constantTimeEquals(expected, input.signature) ? undefined : 'signature-mismatch'
  }

  async function audit(denial: DenialRecord): Promise<void> {
    try {
      await ledger.recordDenial(denial)
    } catch (error) {
      // 拒已经成立，写不下只是审计缺一行 —— 缺的那行必须喊人，不能静默。
      options.onAuditError?.(error, denial)
    }
  }

  /** 3 秒窗口：通知在响应之后自己跑；错误进 `onSettledError`，绝不冒泡给 IM。 */
  function settle(event: ApprovalSettled): void {
    try {
      void Promise.resolve(options.onSettled?.(event)).catch(error => { options.onSettledError?.(error, event) })
    } catch (error) {
      // `Promise.resolve(...)` 的实参求值在 then 链之外：端口同步抛出时不接住就会冒给飞书，
      // 3 秒窗口变成「卡片处理失败」，而账其实已经落好了。
      options.onSettledError?.(error, event)
    }
  }

  function recordNow(requestId: string): ApprovalRequestRecord {
    const fresh = ledger.get(requestId)
    if (fresh === undefined) throw new Error(`approval callback: record ${requestId} vanished between write and notify`)
    return fresh
  }

  return async function handle(input: CallbackInput): Promise<CallbackResponse> {
    // 空 token **不是**「没有秘密」的合法形态：签名期望值是 `sha1(timestamp + nonce + token + body)`，
    // 而方案本身是公开的 —— token 为空时任何能打到这个端口的人都能现算出一个「验得过」的签名，
    // 把一条在逃的审批批掉；`constantTimeEquals` 对两个空串还返回 true，连 `url_verification` 都白放行。
    // 本项目登记的前提是「回调的真实性只能靠签名」，所以配置缺失必须整体拒（并且在解析正文之前，E6）。
    if (options.verificationToken() === '') {
      return { status: 401, body: { code: 'verification-token-unset' } }
    }
    const signed = input.timestamp !== undefined && input.nonce !== undefined && input.signature !== undefined
    // 带了签名头就先验签，验不过连正文都不解析：正文是攻击者可控的字节，让未认证的输入走进
    // JSON.parse 与 schema 判定，等于把解析器当攻击面摊开（E6）。
    if (signed) {
      const failure = authenticate({ rawBody: input.rawBody, timestamp: input.timestamp, nonce: input.nonce, signature: input.signature })
      if (failure !== undefined) return { status: 401, body: { code: failure } }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(input.rawBody) as unknown
    } catch {
      // 走到这里只剩两种情况：签名合法（正文出自我们登记的地址，400 把问题说清楚），
      // 或根本没带签名头（401，且不告诉对方「正文像不像 JSON」）。
      return { status: signed ? 400 : 401, body: { code: signed ? 'malformed-json' : 'missing-signature' } }
    }

    const challenge = challengeSchema.safeParse(parsed)
    if (challenge.success) {
      if (signed) return { status: 200, body: { challenge: challenge.data.challenge } }
      // 配置回调地址那一刻飞书只发 body 里的 token，这是唯一允许无签名的一刻。
      return constantTimeEquals(options.verificationToken(), challenge.data.token ?? '')
        ? { status: 200, body: { challenge: challenge.data.challenge } }
        : { status: 401, body: { code: 'missing-signature' } }
    }

    if (!signed) return { status: 401, body: { code: 'missing-signature' } }

    const envelope = cardCallbackSchema.safeParse(parsed)
    if (!envelope.success) return { status: 200, body: error('这个按钮的数据不完整，请重新发起一次动作。') }
    const value = cardValueSchema.safeParse(envelope.data.event.action.value)
    if (!value.success) return { status: 200, body: error('这个按钮没有带回审批编号，无法核对。') }

    const openId = envelope.data.event.operator.open_id
    const record = ledger.get(value.data.requestId)
    if (record === undefined) return { status: 200, body: error('这条审批已经不存在了。') }
    const at = now()

    if (at > record.expiresAt) {
      // §3.5：`expiresAt` 是安全阀，过了就没人能批 —— 不写审计，因为这是一条合法但迟到的点击。
      return { status: 200, body: error('这条审批已过期，请让发起人重新发起。') }
    }

    if (record.tenantId !== options.tenantId) {
      await audit({ denialId: newDenialId(), requestId: record.requestId, tenantId: record.tenantId, openId, at, reason: 'tenant-mismatch' })
      return { status: 200, body: error('这条审批不属于当前接入的应用。') }
    }

    const approvers = options.approversOf(record)
    if (approvers === undefined) {
      await audit({ denialId: newDenialId(), requestId: record.requestId, tenantId: record.tenantId, openId, at, reason: 'approvers-unresolvable' })
      return { status: 200, body: error('没查到这条审批的审批人名单，先不处理。') }
    }
    if (!approvers.includes(openId)) {
      await audit({ denialId: newDenialId(), requestId: record.requestId, tenantId: record.tenantId, openId, at, reason: 'not-approver' })
      return { status: 200, body: error('这条审批需要由审批人处理，你不是其中之一。') }
    }

    if (value.data.decision === 'reject') {
      // 有活窗口就当场交回它：那次调用这一轮拿到 `rejected`，responder 赢下 CAS 并把卡片置灰。
      // 路由不抢先迁状态，否则 responder 会输掉 CAS 而不去改这张卡（U10 现场）。
      if (options.handToWindow?.(record.requestId, { decision: 'reject', openId })) {
        return { status: 200, body: ok('已拒绝，我会把这个结果告诉发起人。') }
      }
      const won = await ledger.transition(record.requestId, {
        from: ['pending', 'expired', 'recalled'],
        to: 'rejected',
        set: { decidedBy: openId, decidedAt: at },
      })
      if (!won) return { status: 200, body: decided() }
      settle({ record: recordNow(record.requestId), decision: 'reject' })
      return { status: 200, body: ok('已拒绝，我会把这个结果告诉发起人。') }
    }

    // U10 的头一步：先看有没有活着的同步窗口在等这条记录。交到了 = 那次在飞的调用**这一轮**就执行，
    // responder 赢下 `pending→approved` 的 CAS 并置灰卡片。这条路不落批件 —— §3.4.2 那条「批件从落账
    // 到收回」的毫秒级存在期因此不存在，也不需要事后 revoke；路由因此也不 notify 恢复路径（没有要唤醒的
    // 会话，也没有要补发的重放）。记录留 `pending` 直到 responder 迁走，是最坏情况更安全的一侧：
    // responder 万一没接住，记录仍可批、催办继续，而不是「已批准却永不执行」的死账。
    if (options.handToWindow?.(record.requestId, { decision: 'approve', openId })) {
      return { status: 200, body: ok('已批准，这次调用已经在当前回合执行。') }
    }

    // 没有活窗口 → 走唤醒重放：落状态 + 一次性批件，交给恢复路径起新 turn 重放（§3.4）。
    // 授权指纹取自**闸落的参数**，重放时由 responder 现算比对（§3.4.1①）。
    const digest = argsDigest(record.toolArgs as Record<string, unknown>)
    const grantId = newGrantId()
    let approved: { won: boolean; grant?: GrantRecord }
    try {
      approved = await ledger.approve(record.requestId, {
        decidedBy: openId,
        now: at,
        grant: { grantId, toolName: record.toolName, argsDigest: digest, grantExpiresAt: record.expiresAt },
      })
    } catch {
      // approve 内部已把状态补偿回 expired（仍在可批集合里），这里绝不能报「已批准」。
      return { status: 200, body: error('批准没能落账，请稍后再点一次。') }
    }
    if (!approved.won) return { status: 200, body: decided() }
    // 批准后还要过闸、digest 还可能失配：只能说「会自动再执行一次」（§3.4.1 R3）。
    settle({ record: recordNow(record.requestId), decision: 'approve', grantId })
    return { status: 200, body: ok('已批准，这个动作会在下一个回合自动执行一次。') }
  }
}

function error(content: string): unknown {
  return { toast: { type: 'error', content } }
}
function ok(content: string): unknown {
  return { toast: { type: 'success', content } }
}

function decided(): unknown {
  return { toast: { type: 'info', content: '这条审批已经处理过了，不再重复执行。' } }
}

/** 读**未经解析**的正文字节；超限返回 undefined。签名算的是这些字节，不能先解析再拼回去。 */
export async function readRawBody(request: AsyncIterable<Buffer | string>, maxBytes = defaultMaxBodyBytes): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    size += buffer.byteLength
    if (size > maxBytes) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export interface CallbackRouteRouteOptions extends CallbackRouteOptions {
  /** 回调路径。 @default '/office/approval/callback' */
  path?: string | undefined
  /** 挂在 `webServer` 上的正文上限。 @default 64 KiB */
  maxBodyBytes?: number | undefined
}

/** `webServer` 服务的最小面：只要 `register`，不依赖内核包的类型导出。 */
interface WebServerLike {
  register: (route: {
    kind: 'exact'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }) => () => void
}

/**
 * 把路由挂到内核的 `webServer` 上。注册经 `ctx.effect`（内核规约：贡献必须是 effect）。
 * 服务不在（CLI 形态）就不挂 —— 那是**没有异步批准入口**，不是放宽审批：同步窗口照旧会作废未答的询问。
 */
export function installApprovalCallbackRoute(ctx: Context, options: CallbackRouteRouteOptions): void {
  const path = options.path ?? '/office/approval/callback'
  const maxBodyBytes = options.maxBodyBytes ?? defaultMaxBodyBytes
  const handle = createApprovalCallbackHandler(options)
  ctx.effect(() => {
    const server = ctx.get('webServer') as WebServerLike | undefined
    if (server === undefined) return () => {}
    return server.register({
      kind: 'exact',
      path,
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ code: 'method-not-allowed' }))
          return
        }
        const rawBody = await readRawBody(request, maxBodyBytes)
        if (rawBody === undefined) {
          response.writeHead(413, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ code: 'body-too-large' }))
          return
        }
        const result = await handle({
          rawBody,
          timestamp: headerOf(request, 'x-lark-request-timestamp'),
          nonce: headerOf(request, 'x-lark-request-nonce'),
          signature: headerOf(request, 'x-lark-signature'),
        })
        response.writeHead(result.status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(result.body))
      },
    })
  }, 'office-approval: 审批回调路由')
}

/** 多值头（`Set-Cookie` 那种）在这里不可能出现，出现就当没带 —— 宁可走验签失败，不能拼出一个假签名去比。 */
function headerOf(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return typeof value === 'string' ? value : undefined
}
