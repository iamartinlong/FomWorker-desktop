/**
 * 飞书审批卡片渠道（设计 §3.3 的 `ApprovalChannel`、§3.5 的两个动作、§4 的人因防线；§8 第 6 步）。
 *
 * 与第 4 步的回调路由同样的两分法：**卡片形状与决策核是纯函数**，只有 `install` 那一层碰网络。
 * 这样 §4 那几条人因要求（提权原文照搬、"改用工作区内路径"排在"放宽权限"之前、累计放宽次数可见、
 * 参数不进正文只进指纹）能被单测钉住，而不是等真应用联调时靠人眼看出。
 *
 * 五条来自官方文档、直接改变实现的约束：
 * - **`code != 0` 就是失败**：im 的业务错误码多数伴随 HTTP 400。本渠道一律以 `code` 判成败，
 *   不看 HTTP 状态决定放行。
 * - **`uuid` 是请求级去重，不是内容幂等**：官方原话"持有相同 uuid 的请求，在 1 小时内至多成功发送一条"，
 *   且"每次换内容都要换 uuid"。所以同一张卡的**崩溃重发**用同一个确定性 uuid（挡住重复投递），
 *   而**催办重推**（内容变了）必须换 uuid —— 沿用旧的会被去重窗口吃掉，催办就永远发不出去。
 * - **就地改卡用 `PATCH /im/v1/messages/{id}`**，官方明确"仅支持更新卡片消息"，且它没有幂等键；
 *   "把卡片设成某个终态"本身重复执行无害，这就是渠道侧不需要幂等键的理由（也是 U4 的落点）。
 * - **撤回是删除**：`DELETE` 之后消息从会话里消失，不可能"撤回并留一句话"，所以 `recall` 的真实形状是
 *   撤回 + 另发一条文本。撤回时限由企业管理员配置（超窗 230009 是真失败），
 *   已撤回/已删除（230008/230011/230110）按"目的已经达到"处理。
 * - **`tenant_access_token` 要本地缓存**：有效期最长 2 小时；签发新 token 后旧 token 仍有 30 分钟可用，
 *   所以提前刷新是安全的。99991651/99991663（过期/失效）清缓存**只**重试一次。
 */

import { createHash } from 'node:crypto'

import type { ApprovalCard, ApprovalChannel } from './responder.ts'
import { argsDigest, type ApprovalLedger, type ApprovalRequestRecord } from './ledger.ts'

/* -------------------------------------------------------------------------- */
/* 传输：一切网络形状都在这里，测试注入假实现                                   */
/* -------------------------------------------------------------------------- */

export interface FeishuCall {
  readonly method: 'POST' | 'PATCH' | 'DELETE'
  readonly path: string
  readonly query?: Readonly<Record<string, string>> | undefined
  /** 已鉴权调用由渠道带上；获取 token 的那一次没有。 */
  readonly token?: string | undefined
  readonly body?: unknown
}

export interface FeishuReply {
  readonly status: number
  readonly code: number
  readonly msg?: string
  readonly data?: unknown
  readonly tenant_access_token?: string
  readonly expire?: number
}

export type FeishuTransport = (call: FeishuCall) => Promise<FeishuReply>

/** 渠道侧的失败：带着飞书的 `code`，调用方据此区分"撤回已经达成目的"与真故障。 */
export class FeishuApiError extends Error {
  constructor(readonly code: number, message: string, readonly path: string) {
    super(`feishu ${code} at ${path}: ${message}`)
    this.name = 'FeishuApiError'
  }
}

/** 官方错误码里"这件事已经不需要再做了"的那几个 —— 撤回路径专用，别把它们当失败。 */
export const alreadyGoneCodes = new Set([230008, 230011, 230110])

/** token 失效/过期：清缓存重试一次的判据。 */
export const tokenInvalidCodes = new Set([99991651, 99991663])

/* -------------------------------------------------------------------------- */
/* 卡片形状（§4 人因防线落在这里）                                              */
/* -------------------------------------------------------------------------- */

export interface ApprovalCardElement {
  readonly tag: string
  readonly [key: string]: unknown
}

export interface FeishuCardPayload {
  readonly schema: '2.0'
  readonly config: { readonly update_multi: true }
  readonly header: Record<string, unknown>
  readonly body: { readonly elements: readonly ApprovalCardElement[] }
}

/** 卡片状态：决定按钮是否置灰、页脚标签写什么，也决定"已决策"这类终态文案。 */
export type ApprovalCardState =
  | { readonly kind: 'awaiting' }
  | { readonly kind: 'reminded' }
  /**
   * 同步窗口结束、询问作废，但这条审批**还没关门**（台账的 `isDecidable` 仍然为真）。
   * 故意不算终态：按钮保持可点，否则真渠道（撤回 = `DELETE`）会删掉唯一的批准入口 —— §8 第 8 步的 F-E。
   */
  | { readonly kind: 'deferred'; readonly text: string }
  | { readonly kind: 'decided'; readonly text: string }
  | { readonly kind: 'expired' }
  /** 催办重推后，屏幕上那张旧卡。 */
  | { readonly kind: 'superseded' }

export interface CardPolicy {
  /**
   * 本会话累计的放宽权限次数（§4「策略滑坡」：累计放宽次数在卡片上可见）。
   * 次数必须由平台给出：卡片上的每一个数字都是模型看不见、只有账本知道的事实。
   */
  relaxationCount: (record: ApprovalRequestRecord) => number
}

function plain(content: string): { tag: 'plain_text'; content: string } {
  return { tag: 'plain_text', content }
}

function md(content: string): { tag: 'lark_md'; content: string } {
  return { tag: 'lark_md', content }
}

/** 按钮回传值 —— 就是回调路由 `cardValueSchema` 认的那个形状（第 4 步"未测的 action.value 形状"在这里闭合）。 */
export function cardValue(requestId: string, decision: 'approve' | 'reject') {
  return { requestId, decision }
}

/** L3/L4 才要二次确认（§5）；其余一级点击即决。 */
export function needsSecondConfirm(level: ApprovalRequestRecord['riskLevel']): boolean {
  return level === 'L3' || level === 'L4'
}

/**
 * 二次确认弹窗（官方 `confirm` 字段：`title` 必填，老客户端缺了它会点击无反应）。
 *
 * 这是**IM 侧**的人因防线，不是服务端能保证的凭据：弹窗由客户端弹出，回传的 `value` 与我们发卡时
 * 写死的那份完全一样。所以服务端不检查任何"已确认"标记 —— 检查一个攻击者（或手滑的审批人）
 * 无法独立改变的字段是假的安全感。真正的护栏是审批人名单、`expiresAt` 与参数指纹。
 */
function secondConfirmDialog(level: ApprovalRequestRecord['riskLevel']) {
  return {
    title: plain(`确认${level}动作？`),
    text: plain(level === 'L4'
      ? '这个动作影响整个租户，确认后立刻执行且不再询问。'
      : '这个动作不可逆，确认后立刻执行且不再询问。'),
  }
}

/**
 * 组装一张审批卡片。三条纪律：
 * 1. **`displayReason` 原样透传**（D8）—— 提权类询问的原文（"要写到工作区外的 X，
 *    workspace-write 已拒"）是审批人唯一能看到的现场事实，重述一次就会失真。
 * 2. **参数不进正文**（§4 最小暴露）—— 只给 `argsDigest` 前 12 位；批的是快照，
 *    对不上的重放拿不到授权（§3.4.1），指纹就是给人核对用的。
 * 3. **"改用工作区内路径"排在"放宽权限"之前**（§4）—— M0 F4 实测模型会主动建议放宽权限，
 *    卡片不能替它把这条路摆在第一个。
 */
export function buildApprovalCard(
  record: ApprovalRequestRecord,
  state: ApprovalCardState,
  policy: CardPolicy,
): FeishuCardPayload {
  const digest = argsDigest(record.toolArgs as Record<string, unknown>)
  const settled = state.kind === 'decided' || state.kind === 'expired' || state.kind === 'superseded'
  const elements: ApprovalCardElement[] = [
    { tag: 'div', text: md(record.displayReason) },
    {
      tag: 'div',
      text: md([
        `**动作**：${record.actionSummary}`,
        `**风险级**：${record.riskLevel}　**编号**：${record.requestId}`,
        `**参数指纹**：${digest.slice(0, 12)}（批准后按这份参数原样重放）`,
      ].join('\n')),
    },
  ]

  if (needsSecondConfirm(record.riskLevel)) {
    elements.push({
      tag: 'div',
      text: md([
        '这个动作**不可逆**或**影响整个租户**。在放宽权限之前，先考虑：',
        '① 改用工作区内的路径；② 让 Agent 换一种做法。',
        `放宽权限会绕过沙箱保护，且本会话已累计放宽 ${String(policy.relaxationCount(record))} 次。`,
      ].join('\n')),
    })
  }

  if (state.kind === 'reminded') elements.push({ tag: 'div', text: md('这是**唯一一次**催办：仍未获得批准。') })
  if (state.kind === 'deferred') {
    elements.push({ tag: 'div', text: md(`${state.text}\n这条审批**仍然可以批准**，批准会在下一个回合执行一次。`) })
  }
  if (state.kind === 'decided') elements.push({ tag: 'div', text: md(state.text) })
  if (state.kind === 'expired') elements.push({ tag: 'div', text: md('这条审批已过期作废，不再受理。') })
  if (state.kind === 'superseded') elements.push({ tag: 'div', text: md('这张卡已被新的提醒取代，请到最新卡片上处理。') })

  const secondConfirm = needsSecondConfirm(record.riskLevel) && !settled
  // 按钮**平铺**：`.spike/feishu-card-probe.mjs` 对真应用实测，schema 2.0 已不支持 `action`
  // 容器（`ErrCode 200861: unsupported tag action`），`note` 同理；`button` 直接是 body 元素。
  elements.push({
    tag: 'button',
    text: plain(secondConfirm ? '确认批准（不可逆）' : '批准'),
    type: 'primary',
    // 置灰是官方的 `disabled` 字段：终态之后按钮必须点不动，否则同一张卡诱导审批人反复点
    //（§3.6 的点击洪峰）。
    disabled: settled,
    // L3/L4 的批准按钮先弹确认框（§5 的「卡片二次确认」）。回传值与一级点击完全相同 ——
    // 二次确认是 IM 侧的人因防线，服务端不认任何"已确认"标记，见 `secondConfirmDialog`。
    ...(secondConfirm ? { confirm: secondConfirmDialog(record.riskLevel) } : {}),
    behaviors: [{ type: 'callback', value: cardValue(record.requestId, 'approve') }],
  }, {
    tag: 'button',
    text: plain('拒绝'),
    type: 'danger',
    disabled: settled,
    behaviors: [{ type: 'callback', value: cardValue(record.requestId, 'reject') }],
  })

  // 页脚状态标签：`text_tag_list` 的每一项是一个组件，`tag` 写组件名 `text_tag`、颜色写 `color`
  // —— 把颜色名当 `tag`（第一版的写法）会被飞书拒成 `not support tag: blue`（200621，实测）。
  const textTag = (color: string, text: string) => ({ tag: 'text_tag', text: plain(text), color })
  const tag = state.kind === 'decided' ? textTag('green', '已决策')
    : state.kind === 'expired' ? textTag('grey', '已过期')
      : state.kind === 'superseded' ? textTag('grey', '已取代')
        : state.kind === 'reminded' ? textTag('orange', '待批准 · 已催办')
          // 「转后台」仍是蓝色而不是灰色：这张卡点得动，而灰色标签在这里唯一的含义是「别再点了」。
          : state.kind === 'deferred' ? textTag('blue', '待批准 · 转后台')
            : textTag('blue', '待批准')

  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: plain(`审批请求 · ${record.toolName}`), text_tag_list: [tag] },
    body: { elements },
  }
}

/* -------------------------------------------------------------------------- */
/* token 缓存                                                                 */
/* -------------------------------------------------------------------------- */

export interface TokenSource {
  token: () => Promise<string>
  invalidate: () => void
}

/**
 * 本地缓存 `tenant_access_token`（官方要求）。
 *
 * 提前 `skewMs` 刷新是安全的：签发新 token 后旧 token 在剩余有效期内仍可用（官方说 30 分钟内新旧并存），
 * 而**卡到零秒才刷**会让每一次审批洪峰都撞在一次签发的抖动上。并发共享同一次签发：
 * 签发是有日配额的，一个批准序列不该刷 N 次。
 */
export function createTenantTokenSource(
  transport: FeishuTransport,
  appId: string,
  appSecret: string,
  options: { now?: () => number; skewMs?: number } = {},
): TokenSource {
  const now = options.now ?? (() => Date.now())
  const skewMs = options.skewMs ?? 60_000
  let cached: { value: string; expiresAt: number } | undefined
  let inflight: Promise<{ value: string; expiresAt: number }> | undefined

  async function issue(): Promise<{ value: string; expiresAt: number }> {
    const path = '/open-apis/auth/v3/tenant_access_token/internal'
    const reply = await transport({ method: 'POST', path, body: { app_id: appId, app_secret: appSecret } })
    if (reply.code !== 0 || reply.tenant_access_token === undefined) {
      throw new FeishuApiError(reply.code, reply.msg ?? 'tenant_access_token missing', path)
    }
    // 响应给的是剩余秒数；换成绝对时刻，之后每次调用只比一次大小。
    return { value: reply.tenant_access_token, expiresAt: now() + Math.max(0, (reply.expire ?? 7200) * 1000 - skewMs) }
  }

  return {
    async token() {
      if (cached !== undefined && cached.expiresAt > now()) return cached.value
      inflight ??= issue().then(next => {
        cached = next
        return next
      }).finally(() => { inflight = undefined })
      return (await inflight).value
    },
    invalidate() {
      cached = undefined
    },
  }
}

/* -------------------------------------------------------------------------- */
/* 渠道                                                                       */
/* -------------------------------------------------------------------------- */

export interface FeishuChannelOptions {
  transport: FeishuTransport
  tokens: TokenSource
  ledger: ApprovalLedger
  policy: CardPolicy
  /**
   * 这条审批发给谁 —— 与回调路由的 `approversOf` 是同一份名单的两个视角。
   * `undefined` 或空数组 = 发不出去：渠道 **reject**，responder 据此走 E13 交棒，
   * 绝不"发不出去就当作批了"。
   */
  recipientsOf: (record: ApprovalRequestRecord) => readonly string[] | undefined
  /** §3.5 的「IM 通知发起人」收在哪个人身上。 */
  initiatorOf: (record: ApprovalRequestRecord) => string | undefined
  now?: () => number
  onFailure?: (error: unknown, context: { requestId?: string | undefined; path: string }) => void
}

/**
 * 同一条逻辑卡片的确定性 uuid：崩溃恢复后的重发会被飞书的 1 小时窗口吃掉，这正是我们要的。
 * 提醒与首推**必须**不同 uuid（内容变了，官方要求换 uuid，否则提醒直接发不出去）。
 *
 * 编号用哈希而不是原文，因为**真 requestId 是 `randomUUID()`（36 字符）**：把
 * `office-approval-<attempt>-<requestId>` 直接拼出来是 57 字符，飞书在
 * `POST /im/v1/messages` 上回 `99992402 field validation failed` 整条拒绝 —— 卡片一条都没发出去，
 * 台账里也不会有 `cards` 记录。第 8 步那次手工冒烟用的是短编号（`smoke-A-040355`），
 * 恰好躲过了这个坑，所以这里必须按上限来，而不是按"读起来方便"来。
 * 哈希前缀（`push` / `remind` / `notice`）保证同一 requestId 的三种用途互不相干。
 */
export function cardUuid(requestId: string, attempt: 'push' | 'remind'): string {
  return `oa-${attempt}-${uuidDigest(requestId)}`
}

/** 通知文本的 uuid：确定性 ⇒ 崩溃恢复重发被吃掉；与卡片 uuid 不同前缀 ⇒ 不会互相顶掉。 */
function noticeUuid(requestId: string): string {
  return `oa-notice-${uuidDigest(requestId)}`
}

/** 24 位十六进制（≈96 bit）够钉住"同一条请求"，同时让 uuid 落在飞书收得下的长度内。 */
function uuidDigest(requestId: string): string {
  return createHash('sha1').update(requestId, 'utf8').digest('hex').slice(0, 24)
}

export interface FeishuApprovalChannel extends ApprovalChannel {
  /** §3.5：催办重推（换 uuid 的新卡 + 旧卡置灰）。 */
  pushReminder: (record: ApprovalRequestRecord) => Promise<void>
  /** §3.5：过期作废（就地改卡 + 通知发起人）。 */
  markExpired: (record: ApprovalRequestRecord) => Promise<void>
}

export function createFeishuApprovalChannel(options: FeishuChannelOptions): FeishuApprovalChannel {
  const now = options.now ?? (() => Date.now())
  const { transport, tokens, ledger } = options

  async function call<T = unknown>(
    method: FeishuCall['method'],
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<T> {
    const send = async (): Promise<FeishuReply> =>
      await transport({ method, path, query, body, token: await tokens.token() })
    let reply = await send()
    if (tokenInvalidCodes.has(reply.code)) {
      // 失效与过期是同一件事的两个码；清掉缓存重签一次，第二次再错就当故障往外抛。
      tokens.invalidate()
      reply = await send()
    }
    if (reply.code !== 0) throw new FeishuApiError(reply.code, reply.msg ?? 'feishu call failed', path)
    return reply.data as T
  }

  async function sendCard(record: ApprovalRequestRecord, state: ApprovalCardState, uuid: string): Promise<string[]> {
    const recipients = options.recipientsOf(record)
    if (recipients === undefined || recipients.length === 0) {
      throw new Error(`approval channel: no recipient resolved for ${record.requestId}`)
    }
    const content = JSON.stringify(buildApprovalCard(record, state, options.policy))
    const sent: string[] = []
    let lastError: unknown
    for (const openId of recipients) {
      try {
        const data = await call<{ message_id?: string }>('POST', '/open-apis/im/v1/messages', {
          receive_id: openId,
          msg_type: 'interactive',
          content,
          uuid,
        }, { receive_id_type: 'open_id' })
        if (data?.message_id !== undefined) sent.push(data.message_id)
      } catch (error) {
        // 单个收件人失败不吞掉整张卡：只要**有人**收到了，这张卡就送达过，"就地改卡/撤回"有对象。
        // 全数失败才让 `send` reject —— E13 的交棒靠的就是这个信号。
        lastError = error
        options.onFailure?.(error, { requestId: record.requestId, path: '/im/v1/messages' })
      }
    }
    if (sent.length === 0) {
      throw lastError instanceof Error ? lastError : new Error(`approval channel: all ${String(recipients.length)} pushes failed for ${record.requestId}`)
    }
    await ledger.putCard({ requestId: record.requestId, messageIds: sent, recipientIds: [...recipients], pushedAt: now() })
    return sent
  }

  /**
   * 就地改卡。**故意只走台账里那份"能被改到的消息"清单**：句柄记在台账里，
   * 重启之后仍然改得动 —— 这是把 message_id 写进 `cards` 表的唯一理由。
   * 单条改不动不推翻整次操作（卡片已经送达过），只报告。
   */
  async function patch(record: ApprovalRequestRecord, state: ApprovalCardState, messageIds: readonly string[]): Promise<void> {
    const content = JSON.stringify(buildApprovalCard(record, state, options.policy))
    for (const messageId of messageIds) {
      const path = `/open-apis/im/v1/messages/${messageId}`
      try {
        await call('PATCH', path, { content })
      } catch (error) {
        options.onFailure?.(error, { requestId: record.requestId, path })
      }
    }
  }

  async function sendText(openId: string, text: string, requestId: string): Promise<void> {
    try {
      await call('POST', '/open-apis/im/v1/messages', {
        receive_id: openId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
        // 通知类文本每次都是新内容，uuid 用「这条通知是关于谁的」—— 重复投递（崩溃恢复）会被吃掉。
        uuid: noticeUuid(requestId),
      }, { receive_id_type: 'open_id' })
    } catch (error) {
      options.onFailure?.(error, { requestId, path: '/im/v1/messages' })
    }
  }

  function handleOf(requestId: string): { messageIds: readonly string[]; recipientIds: readonly string[] } {
    const handle = ledger.cardHandle(requestId)
    if (handle === undefined) throw new Error(`approval channel: no card handle for ${requestId}`)
    return handle
  }

  const card = (requestId: string): ApprovalCard => ({
    cardId: requestId,
    /**
     * 飞书的点击**不经过渠道**：它由回调路由送进来（§3.7），再经窗口登记表交给还在等的 responder。
     * 所以这里的等待只被 abort 结束 —— 造一张"自己永远不会被点到"的卡是有意的，不是没实现：
     * 渠道若也去等一次点击，同一个决定就有两个来源竞争，而台账只该有一个赢家（§3.6）。
     */
    waitForClick: signal => new Promise<undefined>(resolve => {
      if (signal.aborted) {
        resolve(undefined)
        return
      }
      signal.addEventListener('abort', () => resolve(undefined), { once: true })
    }),
  })

  return {
    async send(record) {
      await sendCard(record, { kind: 'awaiting' }, cardUuid(record.requestId, 'push'))
      return card(record.requestId)
    },
    async update(clicked, text) {
      // `text` 是 responder 给的"已由 X 批准"：落在正文并把按钮置灰（E1）。
      const record = ledger.get(clicked.cardId)
      if (record === undefined) throw new Error(`approval channel: record ${clicked.cardId} vanished`)
      await patch(record, { kind: 'decided', text }, handleOf(clicked.cardId).messageIds)
    },
    /**
     * 就地改成「转后台」态：文案换了，**按钮不置灰**（`deferred` 不是终态）。
     *
     * 之所以不能顺手用 `recall`：真渠道的撤回是 `DELETE`，删掉的正是这条审批唯一能点的入口，
     * 而台账此时仍然收迟到批准（`expired` / `recalled` 都在 `isDecidable` 里），§3.5 的催办还会
     * 为它再推一张卡。于是「转后台」变成一句永远兑现不了的承诺（§8 第 8 步 F-E，假渠道测不出：
     * 它的 recall 只是打个标记）。
     */
    async defer(clicked, text) {
      const record = ledger.get(clicked.cardId)
      if (record === undefined) throw new Error(`approval channel: record ${clicked.cardId} vanished`)
      await patch(record, { kind: 'deferred', text }, handleOf(clicked.cardId).messageIds)
    },
    async recall(clicked, text) {
      const record = ledger.get(clicked.cardId)
      if (record === undefined) throw new Error(`approval channel: record ${clicked.cardId} vanished`)
      const handle = handleOf(clicked.cardId)
      for (const messageId of handle.messageIds) {
        try {
          await call('DELETE', `/open-apis/im/v1/messages/${messageId}`)
        } catch (error) {
          // 已经撤回/已经删除 = 目的已达到，不重做也不报错。超窗（230009）不在这一集合里，照常抛。
          if (error instanceof FeishuApiError && alreadyGoneCodes.has(error.code)) continue
          throw error
        }
      }
      // 撤回是删除，删掉之后"留一句话"只能另发一条 —— 官方语义对我们接口的真实改写。
      for (const openId of handle.recipientIds) await sendText(openId, text, clicked.cardId)
    },
    async pushReminder(record) {
      const previous = ledger.cardHandle(record.requestId)?.messageIds ?? []
      // 内容变了 ⇒ 换 uuid：同 uuid 在 1 小时窗口内会被飞书吃掉，催办就永远发不出去。
      await sendCard(record, { kind: 'reminded' }, cardUuid(record.requestId, 'remind'))
      // 旧卡就地置灰：屏幕上留两张能点的卡，点哪张都算数（§3.6 的 CAS 兜第二次），
      // 但审批人该知道哪张是最新的。
      await patch(record, { kind: 'superseded' }, previous)
    },
    async markExpired(record) {
      const handle = ledger.cardHandle(record.requestId)
      // 没有句柄 = 这张卡从没送达过，没什么可改的；发起人的通知仍然要发。
      if (handle !== undefined) await patch(record, { kind: 'expired' }, handle.messageIds)
      const openId = options.initiatorOf(record)
      if (openId !== undefined) {
        // 措辞按 §3.5：因未获批准，任务未完成 —— 不是"被拒绝"，没有人做过这个决定（D4）。
        await sendText(openId, `你的请求「${record.actionSummary}」因未获批准已过期（编号 ${record.requestId}），任务未完成。`, record.requestId)
      }
    },
  }
}

/**
 * 默认的人因策略：**本会话累计真正放行过的提权次数**。
 *
 * 口径是「带 `sandbox_permissions` 且状态已到 approved/consumed」的审批条数 ——
 * 只数真正批过的，不数被拒的，否则卡片上的数字会变成"这个会话有多吵"而不是"策略滑坡了多少"。
 * `pending` 的那一条不算在内：它还没发生，算进去等于把"正在请求的这一次"显示成"已经放宽过一次"。
 */
export function sessionRelaxationCount(ledger: ApprovalLedger): CardPolicy['relaxationCount'] {
  return record => ledger.requestsOf(record.sessionId).filter(other =>
    (other.status === 'approved' || other.status === 'consumed')
    && other.toolArgs !== null
    && typeof other.toolArgs === 'object'
    && !Array.isArray(other.toolArgs)
    && 'sandbox_permissions' in (other.toolArgs as Record<string, unknown>)).length
}

export function installFeishuApprovalChannel(options: Omit<FeishuChannelOptions, 'policy'> & { policy?: CardPolicy }): FeishuApprovalChannel {
  return createFeishuApprovalChannel({
    ...options,
    policy: options.policy ?? { relaxationCount: sessionRelaxationCount(options.ledger) },
  })
}
