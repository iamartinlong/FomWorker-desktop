/**
 * 最小**入站适配器**决策核（M2/C · 层①接入层）：把「IM 入站消息」路由到一个**会话创建**。
 *
 * 职责（纯决策，与传输/内核解耦）：
 * 1. 按 `open_id` 经 `officeRouter.planSession` 解析创建计划（**未绑定 → 丢弃**，fail-closed）；
 * 2. 把 `{cwd, agentPreset, identityNotice}` + 消息正文交给注入的 `CreateSessionPort` 建会话。
 *
 * 传输（飞书长连接桥）与内核建会话口（`ctx.agents`/`sessionController`）是后续接线；本模块只定决策形状。
 * 依据：`docs/02-设计/路由与权限模型设计v0.1.md` §4、`办公Agent平台架构设计方案v1.0.md` §2。
 */

import { planSession, type SessionCreationPlan } from '../office-router/wiring.ts'
import type { RouterTables } from '../office-router/directory.ts'

/** 一条入站消息（最小形状）。 */
export interface InboundMessage {
  /** 发送者的 IM `open_id`/`user_id`。 */
  readonly openId: string
  /** 消息正文（交给会话作为首个输入）。 */
  readonly text: string
}

/** 建会话请求 = 创建计划 + 正文。 */
export interface SessionCreateRequest extends SessionCreationPlan {
  readonly text: string
}

/** 内核建会话口（结构化；传输层用 `ctx.agents`/`sessionController` 实现）。 */
export interface CreateSessionPort {
  create(request: SessionCreateRequest): Promise<{ sessionId: string }>
}

/** 入站处理结果。 */
export type InboundResult =
  | { readonly status: 'created'; readonly sessionId: string }
  | { readonly status: 'unauthorized' }
  | { readonly status: 'failed'; readonly message: string }

/** 入站处理依赖。 */
export interface InboundDeps {
  readonly tables: RouterTables
  readonly create: CreateSessionPort
}

/**
 * 处理一条入站消息。
 * @param message - 入站消息。
 * @param deps - 路由表 + 建会话口。
 * @returns `created` / `unauthorized`（未绑定）/ `failed`（建会话抛错）。
 */
export async function handleInbound(message: InboundMessage, deps: InboundDeps): Promise<InboundResult> {
  const plan = planSession(message.openId, deps.tables)
  if (plan === undefined) return { status: 'unauthorized' }
  try {
    const { sessionId } = await deps.create.create({ ...plan, text: message.text })
    return { status: 'created', sessionId }
  } catch (error) {
    return { status: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}
