/**
 * M1 同步窗口裁决者（设计 §3.3、D3/D4，§8 第 3 步）。
 *
 * 它在 `approval/request` 的 waterfall 最前面问一次：卡片在 `W_sync` 内被人点了就直接给结局；
 * 没点到就**作废本次询问**（`cancelled`）并把记录留在台账里等延迟批准（第 4 步的回调路由）。
 *
 * 两条内核事实决定了它的形状：
 * - 内核 race 到 `cancelled` 之后**不会通知监听器**（`user-approval/src/index.ts:294-303`），
 *   所以卡片撤回与台账落状态必须靠我们自己观察 `req.signal`，不然留下一张永远等不到答复的卡；
 * - waterfall 的 terminal 是 `'unavailable'`（`:283`），我们**返 `undefined` 就会独占这条链**，
 *   Web UI 自带的面板再也问不到 —— 所以不归我们管时必须 `next()`（F1/E13）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { argsDigest, isDecidable, type ApprovalLedger, type ApprovalRequestRecord } from './ledger.ts'

/** 一次真实点击：谁点的 + 点的是什么。审批人集合校验是第 4 步（E5）。 */
export interface ApprovalClick {
  readonly decision: 'approve' | 'reject'
  readonly openId: string
}

export interface ApprovalCard {
  readonly cardId: string
  /** 等到一次真实点击；`signal` abort 时 resolve `undefined` —— 这张卡不再有结局可等。 */
  waitForClick: (signal: AbortSignal) => Promise<ApprovalClick | undefined>
}

/**
 * 卡渠道（第 3 步用终端模拟实现，第 6 步换飞书）。
 * `send` 失败必须 reject —— E13 的交棒靠这个信号，而不是靠返回一张假卡。
 */
export interface ApprovalChannel {
  send: (record: ApprovalRequestRecord, signal: AbortSignal) => Promise<ApprovalCard>
  /** 就地更新（"已决策"），不撤回 —— E1。 */
  update: (card: ApprovalCard, text: string) => Promise<void>
  /**
   * 就地更新成「已转后台，仍可批准」：渠道必须让这张卡**保持能点**（§8 第 8 步 F-E）。
   * 用在询问作废、但这条审批的门还开着的时候。
   */
  defer: (card: ApprovalCard, text: string) => Promise<void>
  /** 撤回并留一句话。只能用于**批准之门已经关上**的记录，否则 IM 里再也没有批准入口。 */
  recall: (card: ApprovalCard, text: string) => Promise<void>
}

export interface ResponderOptions {
  ledger: ApprovalLedger
  channel: ApprovalChannel
  /**
   * 在飞窗口的登记表。产品组合必须传：真实形态下卡片点击是经第 4 步的回调路由进来的，
   * 不接回这个窗口，用户批了也要等窗口自己到期（最坏 90 秒），期间那次调用拿着 `cancelled` 继续往下走。
   */
  windows?: PendingApprovalWindows
  now?: () => number
  /**
   * 交棒成功后「把这条询问从账上退役」写不下去的去处。
   * 写不下去不改变已经由内侧应答者作出的决策（决策不是我们给的），但那条记录会留在
   * `pending` 上继续可批 —— 那是一次真批准换来两次执行，必须有人知道。
   */
  onHandoffError?: (requestId: string, error: unknown) => void
}

/** 窗口还在等时，把一次外部决策交进来的句柄。 */
export type ApprovalWindowHandler = (click: ApprovalClick) => void

/**
 * 正在等同步裁决的窗口，按 `requestId` 索引。
 *
 * 一条记录只有一个窗口：`requestId` 每次 ask 都是新的，且窗口一旦拿到结局就把状态迁走，
 * 所以这里不需要计数、也不需要在重复登记时裁决先后。
 */
export class PendingApprovalWindows {
  readonly #handlers = new Map<string, ApprovalWindowHandler>()

  /** 登记一个正在等的窗口，返回撤销句柄（窗口结束时必须调用，否则决策会交给一个已经不存在的等待方）。 */
  register(requestId: string, handler: ApprovalWindowHandler): () => void {
    this.#handlers.set(requestId, handler)
    return () => {
      if (this.#handlers.get(requestId) === handler) this.#handlers.delete(requestId)
    }
  }

  /** 有人在等就交付并返回 true；没人等返回 false —— 调用方据此决定要不要唤醒会话。 */
  settle(requestId: string, click: ApprovalClick): boolean {
    const handler = this.#handlers.get(requestId)
    if (handler === undefined) return false
    handler(click)
    return true
  }
}

/**
 * 按台账里那条记录的当前状态给结局。
 *
 * 只有真的 `approved` 才放行；`rejected` 是别人的决定就照它的结局走；其余（`expired` /
 * `recalled` / `consumed`）都是「这张卡已不再有可执行的批准」→ 作废本次询问。
 * 走到这里通常意味着另一个裁决者（第 4 步的回调路由）先把状态迁走了。
 */
function outcomeOf(record: ApprovalRequestRecord | undefined): ApprovalOutcome {
  if (record === undefined) return 'cancelled'
  switch (record.status) {
    case 'approved': return 'allowed-once'
    case 'rejected': return 'rejected'
    default: return 'cancelled'
  }
}

export function createApprovalResponder(options: ResponderOptions) {
  const now = options.now ?? (() => Date.now())
  const { ledger, channel } = options

  return async function approvalResponder(
    req: ApprovalRequest,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    // 提权路径的询问可能没有 callId（F4）；没有 callId 就换不回闸落的快照 → 不是我们的问题，交棒。
    if (req.callId === undefined) return await next()
    const record = ledger.findByCall(req.callId)
    if (record === undefined) return await next()

    // 一次带 `sandbox_permissions` 的调用，内核会**用同一个 callId 问两次**：先是我们的闸在
    // `pre-execute` 返 `ask` 之后由服务发出的那次，然后是工具体里 `approveEscalation`
    // （`packages/sandbox/sandbox/src/escalation.ts:190`）为了换沙箱模式再发的那次。
    // 第二次问不是新的一次请求 —— 决定已经落在这次调用上，直接兑现它。若让它继续往下走，
    // 它会再发一张卡等人点（第 8 步真进程实测：15:07:19 批准好的写入堵到 15:17 窗口末尾，
    // 中间审批人还被同一件事问了第二遍，而那张第二张卡已经点不动了）。
    // 只认 `approved`/`consumed`/`rejected` 这三种「这次调用已经有主人答过」的状态；
    // `pending`/`expired`/`recalled` 一律照常开窗口 —— 没人答过的决定不能凭空兑现。
    if (record.status === 'approved' || record.status === 'consumed') return 'allowed-once'
    if (record.status === 'rejected') return 'rejected'

    const digest = argsDigest(record.toolArgs as Record<string, unknown>)
    const granted = await ledger.consumeGrant(record.toolName, digest, now())
    if (granted !== undefined) {
      // §3.4.1③：重放一定会再问一次，这一支是**正确性要求**而不是优化 ——
      // 没有它，用户对同一个动作会被问第二遍。
      await ledger.transition(record.requestId, { from: ['pending'], to: 'consumed' })
      return 'allowed-once'
    }

    // 窗口从 `record.windowEndsAt` 读，不在这里重算第二个时长值。
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort('window-expired'), Math.max(0, record.windowEndsAt - now()))
    const upstream = req.signal
    const onUpstreamAbort = () => controller.abort(upstream?.reason)
    upstream?.addEventListener('abort', onUpstreamAbort, { once: true })

    // 决策也可以从外面进来（第 4 步的回调路由 → 第 5 步的恢复路径）。登记排在发卡之前：
    // 一次落在「正在发这张卡」期间的批准仍然要交给这个窗口，而不是另起一个 turn。
    const inbound = Promise.withResolvers<ApprovalClick>()
    let settledExternally = false
    const release = options.windows?.register(record.requestId, click => {
      settledExternally = true
      inbound.resolve(click)
    })

    try {
      let card: ApprovalCard | undefined
      try {
        card = await channel.send(record, controller.signal)
      } catch {
        // E13：渠道故障不得变成放行，也不得变成"我们替用户拒了" ——
        // 交棒给链条剩下的 answerer（Web UI 面板）；都没人答则内核归一化成 unavailable → 拒。
        // 唯一的例外：结局已经从外面到了。点得动这张卡说明它其实送达过，
        // 这时交棒等于把一次真批准吞掉 —— 恢复路径已经认定窗口接住了它，不会再叫醒会话。
        if (!settledExternally) {
          const outcome = await next()
          // 内侧应答者放行 = 这次询问已经被用掉，工具这一轮就会执行。记录若还留在 `pending`，
          // 一条迟到的 IM 批准会把同一个动作再批一次、再执行一次（真进程实测到的洞），
          // 所以这里把它迁成 `consumed` —— 谁答的我们不署名（不伪造 open_id，D4 同一理由）。
          // 拒绝与无人应答**不**迁：那条批准的门该不该开，留给后面的裁决自己决定。
          if (outcome === 'allowed-once') {
            await ledger.transition(record.requestId, { from: ['pending'], to: 'consumed' })
              .catch(error => options.onHandoffError?.(record.requestId, error))
          }
          return outcome
        }
      }

      // 卡片还没送达但结局已到 ⇒ 只剩 `inbound` 这一条路，它一旦决议就带着一个结局。
      const click = card === undefined
        ? await inbound.promise
        : await Promise.race([card.waitForClick(controller.signal), inbound.promise])
      // 外面已经给出结局时渠道那边还在等这一次点击，撤掉它的等待。
      if (settledExternally) controller.abort('settled-externally')
      if (click === undefined) {
        const expired = controller.signal.reason === 'window-expired'
        await ledger.transition(record.requestId, { from: ['pending'], to: expired ? 'expired' : 'recalled' })
        // 撤不撤卡由**批准之门还开不开**决定，不由「这次询问结没结束」决定：
        // `expired`（超窗转后台）与 `recalled`（调用方中止）都还在 `isDecidable` 里，路由照收迟到批准，
        // §3.5 的催办也会继续为它推卡。而真渠道的撤回是 `DELETE`（feishu-channel.ts 头部第 4 条），
        // 一删就把这条审批唯一的批准入口删掉了 —— 第 8 步在真飞书上实测到的 F-E：
        // 台账自称「已转后台等待审批」，IM 里却一张点得动的卡都没有。
        if (card !== undefined) {
          const current = ledger.get(record.requestId)
          if (current !== undefined && isDecidable(current, now())) {
            await channel.defer(card, expired ? '同步窗口内没人应答，已转后台等待审批' : '本次询问已作废，这条审批仍可批准')
          } else {
            await channel.recall(card, '本次询问已作废')
          }
        }
        // D4：必须是 cancelled —— 记成 rejected 等于在审计里伪造一个用户从未做出的拒绝。
        return 'cancelled'
      }

      const decisionAt = now()
      const to = click.decision === 'approve' ? 'approved' : 'rejected'
      const won = await ledger.transition(record.requestId, {
        from: ['pending'],
        to,
        set: { decidedBy: click.openId, decidedAt: decisionAt },
      })
      // 输掉 CAS 时以账上的决定为准：回调路由可能已经在另一个进程里把这条批完了，
      // 而它给的结局（`approved` → allowed-once）就是这一次在飞的调用要的答案。
      if (!won) return outcomeOf(ledger.get(record.requestId))

      // 同窗口内已放行，工具这一轮就会执行，不需要再落 grant（§3.3）。
      // 卡片送达失败时没有可更新的对象，按钮上的回执由回调路由自己给（§8 第 4 步）。
      if (card !== undefined) {
        await channel.update(card, click.decision === 'approve' ? `已由 ${click.openId} 批准` : `已由 ${click.openId} 拒绝`)
      }
      return click.decision === 'approve' ? 'allowed-once' : 'rejected'
    } finally {
      clearTimeout(timer)
      upstream?.removeEventListener('abort', onUpstreamAbort)
      // 撤销必须早于本函数返回：窗口一旦不存在，迟到的批准就得走唤醒那条路。
      release?.()
    }
  }
}

/**
 * 以 `prepend: true` 挂载 —— 先于 Web UI 自带面板问；面板仍在链条更内侧，
 * 渠道故障时（E13）它能被 `next()` 问到。
 */
export function installApprovalResponder(ctx: Context, options: ResponderOptions): () => boolean {
  return ctx.on('approval/request', createApprovalResponder(options), { prepend: true })
}
