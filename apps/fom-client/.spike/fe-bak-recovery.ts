/**
 * M1 恢复路径（设计 §3.4、D7，§8 第 5 步）。
 *
 * 一条迟到的批准只能靠「起新 turn 重放」落地：内核的 `approval.request()` 必须在 open turn 内，
 * 被作废的那次调用早已离开 dispatch 队列，原地续批在原理上不成立。本模块因此只做三件事：
 *
 * 1. 还有同步窗口在等这条记录 → 把结局交给它。这次调用现在就执行，所以刚发出的批件当场收回
 *    （留着它，之后任何一次同工具同参数的调用都会不问自取地执行）。
 * 2. 没有窗口 → 按内核 `schedule` 的投递三件套（`resolveAgent` → `followup` → `flush`）
 *    把决策投进会话，批件留在台账里等重放时由 responder 消费。
 * 3. 会话唤不起来 → 把批准**补偿**回可批准状态并收回批件，让用户的下一次点击仍能成；
 *    绝不留下「账上已批准、永远不会执行」的死账。
 *
 * 铁律：绝不绕过 agent loop 直接执行已批准的动作 —— 那样模型不知道事情发生过，
 * 下一轮会重复规划或作出矛盾叙述（§3.4）。
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ApprovalLedger, ApprovalRequestRecord } from './ledger.ts'
import type { ApprovalSettled } from './callback-route.ts'
import type { PendingApprovalWindows } from './responder.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 平台代投的审批答复。与 `schedule` 同一个先例：生产者自己声明 kind（F15）。 */
    'approval-decision': { kind: 'approval-decision' } & ContextFormed
  }
}

/** 唤醒失败的两种去处；两者都不改变「决策已经落账」这个事实。 */
export type RecoveryFailure = 'agent-unresolvable' | 'persistence-unacknowledged'

export interface ApprovalRecoveryOptions {
  ledger: ApprovalLedger
  windows: PendingApprovalWindows
  /**
   * 内核里这一步是 `ctx.sessionController.resolveAgent(sessionId)`：冷会话也要能起来（E3）。
   * 返回 `undefined` 表示这个会话唤不醒（已删除、不属于本进程）。
   */
  resolveAgent: (sessionId: string) => Promise<Agent | undefined>
  /**
   * 内核里这一步是 `ctx.sessions.flush(session)`。`false` 表示没有任何持久化应答者确认过，
   * 也就是消息只活在内存里 —— 进程此刻崩掉，这次重放就消失了。
   */
  flush: (session: Session) => Promise<boolean>
  now?: () => number
  /** 唤醒/持久化的问题必须有人知道（催办与告警都挂这里），台账不会自己喊人。 */
  onFailure?: (failure: RecoveryFailure, event: ApprovalSettled, error?: unknown) => void
}

/**
 * 重放指令的正文。
 *
 * 参数快照必须**一字不改地**给出去，包括 `justification`：内核的 `validateEscalationArgs`
 * （`packages/sandbox/sandbox/src/escalation.ts:52`）规定带 `sandbox_permissions` 就必须带非空
 * `justification`，剔掉它等于每次提权重放都在派发之前就失败。`justification` 不参与 digest（§3.4.1①），
 * 所以模型重写它也不会让批件 miss —— 带上原话只是让「参数一字不改」这句指令真的成立。
 */
function decisionText(record: ApprovalRequestRecord, decidedBy: string): string {
  const payload = JSON.stringify({ name: record.toolName, arguments: record.toolArgs })
  return [
    `[审批决策] 编号 ${record.requestId}：${record.actionSummary}`,
    `由 ${decidedBy} ${record.status === 'rejected' ? '拒绝' : '批准'}。`
    + '这是对你上一次请求的答复，不是新的用户指令。',
    record.status === 'rejected'
      ? '不要再次尝试这个动作，也不要换一种写法绕过审批；请把结果告诉用户并询问下一步。'
      : '请原样重放下面这次工具调用，参数一字不改。'
      + '这次批准只对这组参数有效一次，改动参数会重新触发审批。',
    `tool_call_json: ${payload}`,
  ].join('\n')
}

export function createApprovalRecovery(options: ApprovalRecoveryOptions) {
  const { ledger, windows } = options

  /**
   * 收回批件并退回可批准状态。顺序是有意的：先收批件再迁状态 ——
   * 反过来会让中间态「已可批但批件还在」有机会被另一次点击消费掉两张。
   */
  async function compensate(event: ApprovalSettled): Promise<void> {
    if (event.decision !== 'approve') return
    if (event.grantId !== undefined) await ledger.revokeGrant(event.grantId).catch(() => {})
    await ledger.transition(event.record.requestId, { from: ['approved'], to: 'expired' }).catch(() => {})
  }

  return async function recover(event: ApprovalSettled): Promise<void> {
    const { record } = event
    const decidedBy = record.decidedBy ?? 'unknown'

    // 窗口还活着：由那次在飞的调用执行，不注入消息、不起第二个 turn。
    if (windows.settle(record.requestId, { decision: event.decision, openId: decidedBy })) {
      if (event.grantId !== undefined) await ledger.revokeGrant(event.grantId)
      return
    }

    const message = createUserMessage({
      content: [{ type: 'text', text: decisionText(record, decidedBy) }],
      source: { kind: 'approval-decision' },
    })

    let agent: Agent | undefined
    try {
      agent = await options.resolveAgent(record.sessionId)
    } catch (error) {
      await compensate(event)
      options.onFailure?.('agent-unresolvable', event, error)
      return
    }
    if (agent === undefined) {
      await compensate(event)
      options.onFailure?.('agent-unresolvable', event)
      return
    }

    // `followup` 同步把消息插进 inbox，内核保证它与在跑的 turn 串行（不会并发两个 turn，E11）。
    agent.followup(message)
    let flushed = false
    try {
      flushed = await options.flush(agent.session)
    } catch (error) {
      options.onFailure?.('persistence-unacknowledged', event, error)
      return
    }
    // 消息已经在内存里且驱动已被叫醒，此时**不能**补偿：收回批件只会让这轮重放重新问一遍人。
    // 未确认的只是持久性 —— 进程若在落盘前崩掉，这条批准留在台账里，批件也留着，但没人再触发它。
    // 这是 §3.5 催办要兜的底，不是这里能修的东西，所以只报告。
    if (!flushed) options.onFailure?.('persistence-unacknowledged', event)

  }
}
