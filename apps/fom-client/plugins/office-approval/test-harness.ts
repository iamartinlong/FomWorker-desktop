/**
 * 审批链路的测试底座（不是产品代码）。
 *
 * 组合方式抄内核自己的 ask 路由测试 `packages/core/tools/tests/tools.spec.ts:799-937`：
 * 真 `ToolRuntime` + 真 `ApprovalService` + 真实 json 台账。不 mock 注册表 ——
 * F7（ask 到底带不带 `callId` 与同一个 `signal`）只有在真 registry 里走一遍才算验过。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome, ApprovalPolicy, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import ScheduleService from '@deepseek-ai/dsh-schedule'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { approvalLedgerDomain, ApprovalLedger, type LedgerDomain, type RiskLevel } from './ledger.ts'
import { installRiskGate, type RiskRuleTable } from './risk-gate.ts'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  // Windows 上递归删与仍在飞的写会撞 ENOTEMPTY：给几次重试，别让清理把一次绿跑判红（2026-10-17 去 flake）。
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

export async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'office-approval-'))
  roots.push(root)
  return root
}

const sessionId = SessionId('office-approval-session')

/** 一个带 open turn 的假 agent：`approval/request` 要求会话在 turn 中，否则 `request()` 抛。 */
export function fakeAgent(): Agent {
  const session = Session.create(sessionId)
  session.append('turn/start', { turn: 1 })
  return { session } as unknown as Agent
}

/** 参数表覆盖内核 `write` 的真实形状：提权两字段是声明过的参数，不会被校验剥掉。 */
function probe(name: string) {
  const calls: unknown[] = []
  const tool = defineTool({
    name,
    description: `probe ${name}`,
    parameters: {
      file_path: { type: 'string' },
      content: { type: 'string' },
      to: { type: 'string' },
      sandbox_permissions: { type: 'string' },
      justification: { type: 'string' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      calls.push(args)
      return 'done'
    },
  })
  return { tool, calls }
}

/**
 * 让指定表的记录写入失败的后端包装 —— 台账与闸的 E12 靠它，而不是靠改内核代码。
 *
 * `gate` 用于「先正常写、到某一刻才开始失败」的用例（比如 responder 的交棒退役：那条记录
 * 必须先落得下去，否则测的是闸的 fail-closed，不是退役写失败）。
 */
export function rejectingBackend(root: string, table: string, gate: () => boolean = () => true): StorageBackend {
  const base = new JsonStorageBackend(root)
  const fail = () => Promise.reject(new Error('simulated disk failure'))
  return {
    close: () => base.close(),
    kv: {
      open: async (descriptor: KvUnitDescriptor): Promise<KvUnit> => {
        const unit = await (base.kv.open(descriptor) as Promise<KvUnit>)
        return {
          loadAll: () => unit.loadAll(),
          putRecord: (target, key, value) => (target === table && gate() ? fail() : unit.putRecord(target, key, value)),
          deleteRecord: (target, key) => unit.deleteRecord(target, key),
          setGlobal: value => unit.setGlobal(value),
          close: () => unit.close(),
        }
      },
    },
  }
}

/**
 * 分级字典（§5）：只读 L0；工作区内幂等写 L1；带 `sandbox_permissions` 的提权重试 L3；
 * 对外可见的发送 L2。`mail` 未登记 → 按 L4。
 */
export const gateRules: RiskRuleTable = {
  read: { level: 'L0' },
  write: {
    level: args => (args as { sandbox_permissions?: string }).sandbox_permissions === undefined ? 'L1' : 'L3',
    summarize: args => `写入 ${(args as { file_path?: string }).file_path ?? '?'}`,
  },
  send_email: { level: 'L2', summarize: args => `发送邮件给 ${(args as { to?: string }).to ?? '?'}` },
}

export const escalated = {
  file_path: 'C:\\Users\\demo\\report.docx',
  content: 'hello',
  sandbox_permissions: 'danger-full-access',
  justification: '目标在会话工作区之外，需要超出 workspace-write 的访问权限',
}

/**
 * 模拟内核 Web UI 自带的审批面板：非提权一律交棒，提权一律放行。
 *
 * 装它的理由是 F1/§3.3 与 E13 都建立在「waterfall 里我们后面还有人」这个前提上，
 * 而 `ctx.on` 的注册顺序决定谁先被问到 —— 所以它必须在探针工具之前装好，
 * 由 `boot({ panelSimulator: true })` 在固定位置装载，而不是在各用例里随手 `ctx.on`。
 */
const UserApprovalPanelSimulator = {
  name: 'user-approval-panel-simulator',
  inject: [] as const,
  apply(ctx: Context): void {
    ctx.on('approval/request', (_req, next) => next())
  },
}

export interface Harness {
  ctx: Context
  ledger: ApprovalLedger
  /**
   * 已打开的台账域。恢复路径的部分失败用例用它造一个「写链会在退回 `expired` 时抛」的子类台账，
   * 从而钉住 compensate 的中间态（不靠 `as unknown as` 强塞一个假账本）。
   */
  domain: LedgerDomain
  /** 台账落盘的根目录；重启测试用同一个值重开。 */
  root: string
  /** 闸每次问人之前落的 requestId，按顺序。 */
  issued: string[]
  /** 每个探针工具真实收到的参数（证明有没有被改写、有没有执行）。 */
  calls: Record<'read' | 'write' | 'send_email' | 'mail', unknown[]>
  /**
   * `boot({schedule:true})` 时假 agent 真实收到的投递。催办/过期在模型那一侧的**唯一**形态
   * 就是这里的一条消息（`followup` 只把消息插进 inbox），所以它既证明投递发生过，
   * 也提醒我们：平台的对账不能靠读它，得靠 `catalog()` 的回执。
   */
  delivered: ScheduledDelivery[]
  /** `boot({schedule:true})` 里那个真 session 的编号；审批记录要写同一个 `sessionId`。 */
  scheduleSessionId?: string
}

export interface ScheduledDelivery {
  readonly text: string
  readonly source: string
}

export interface BootOptions {
  root?: string
  backend?: StorageBackend
  rules?: RiskRuleTable
  tenantOf?: (sessionId: string) => { tenantId: string } | undefined
  /** 传给闸的时间源；不传用真实时钟（同步窗口要跑真定时器时必须用真实时钟）。 */
  gateNow?: () => number
  windowMs?: number
  /** 挂 answerer 的钩子（假 responder 或真 responder）；不传则没有 answerer。 */
  answer?: (ctx: Context, ledger: ApprovalLedger) => void
  /** 台账有效期覆盖（§3.5 的 L3/L4 收紧）；E10 用它造一张会过期的批件。 */
  expiresMs?: Partial<Record<RiskLevel, number>>
  /**
   * 装上模拟的 Web UI 应答器，排在探针工具之前 —— waterfall 的先后因此是真的。
   * 第 3 步的 E13 用例必须不开它（没有面板时交棒才会归一化成 `unavailable`）。
   */
  panelSimulator?: boolean
  /**
   * 台账编号前缀。产品里编号是 `randomUUID()`，测试里要可预期；
   * 重启那组用例跑在同一个目录上，两个进程必须用不同前缀，否则第二条记录会盖掉第一条。
   */
  requestIdPrefix?: string
  /**
   * 挂上真 `schedule` 服务（第 6 步的催办/过期只有真定时器才算验过）。
   * `schedule` 的五个 inject 里 `sessionController` 与 `sessionPersistence` 不在本 harness 的
   * 组合里，按内核自己的 harness 做法（`packages/schedule/schedule/tests/harness.ts:74-105`）
   * 提供桩：`resolveAgent` 交回一个只记录 `followup` 的假 agent，flush 用真应答者确认。
   */
  schedule?: boolean
  /**
   * 挂 schedule 时给那个真 session 的编号；审批记录的 `sessionId` 必须与它一致，投递才找得到 agent。
   */
  scheduleSessionId?: string
  /**
   * 审批服务的**部署默认**策略（E8）。会话里 `approval/policy` 那条事件是逐会话覆盖，
   * 内核读它优先于这个默认，所以 E8 的两个分支分别用这里和 `setApprovalPolicy` 造。
   */
  approvalPolicy?: ApprovalPolicy
}

/** 装出与产品 patch 相同的组合：审批服务、工具运行时、真实 json 台账、风险闸。 */
export async function boot(options: BootOptions = {}): Promise<Harness> {
  const root = options.root ?? await newRoot()
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ApprovalService, options.approvalPolicy === undefined ? {} : { policy: options.approvalPolicy })
  await ctx.plugin(Storage)
  if (options.backend === undefined) {
    await ctx.plugin(StorageJson, { root })
  } else {
    ctx.storage.backend.register('json', options.backend)
    ctx.provide(storageBackendServiceKey('json'), options.backend)
  }
  await ctx.plugin(StorageDomain, { backend: 'json' })

  const domain = await ctx.storageDomain.open(approvalLedgerDomain)
  const ledger = new ApprovalLedger(domain)
  const issued: string[] = []
  // 编号前缀：产品里是 randomUUID，测试里要可预期；重启那组用例在同一目录上开两个进程，
  // 前缀不同才不会让第二条记录盖掉第一条（`requests.put` 是按主键覆盖的）。
  const prefix = options.requestIdPrefix ?? 'req-gate'
  // 面板先装：产品里它是内核自带的，我们的 responder 只能靠 `{prepend:true}` 抢在它前面。
  // 第 3 步的 E13 用例必须不开它 —— 没有面板时交棒才会归一化成 `unavailable`。
  if (options.panelSimulator === true) await ctx.plugin(UserApprovalPanelSimulator)
  const probes = {
    read: probe('read'),
    write: probe('write'),
    send_email: probe('send_email'),
    mail: probe('mail'),
  }
  for (const entry of Object.values(probes)) ctx.tools.register(entry.tool)

  installRiskGate(ctx, {
    ledger,
    rules: options.rules ?? gateRules,
    tenantOf: options.tenantOf ?? (() => ({ tenantId: 'tenant-1' })),
    ...(options.gateNow !== undefined ? { now: options.gateNow } : {}),
    ...(options.windowMs !== undefined ? { windowMs: options.windowMs } : {}),
    ...(options.expiresMs !== undefined ? { expiresMs: options.expiresMs } : {}),
    newRequestId: () => {
      const requestId = `${prefix}-${issued.length + 1}`
      issued.push(requestId)
      return requestId
    },
  })

  const delivered: ScheduledDelivery[] = []
  let scheduleSessionId: string | undefined
  if (options.schedule === true) {
    // 投递路径在 `followup` 之后立刻 `sessions.flush(agent.session)` 取持久化确认
    // （`packages/schedule/schedule/src/runtime.ts:119-133`），**没有确认就没有投递回执**，
    // 任务还会留在 active 里被重投 —— 我们的对账靠那条回执，所以这里的 agent 必须带一个
    // **在 store 里活着**的 session（`sessions.flush` 对 detached session 直接抛）。
    const scheduleSession = ctx.sessions.create(SessionId(options.scheduleSessionId ?? 'office-schedule-session'))
    scheduleSessionId = scheduleSession.id
    ctx.provide('sessionController', {
      resolveAgent: async () => ({
        agent: {
          session: scheduleSession,
          followup: (message: ReturnType<typeof createUserMessage>) => {
            const block = message.content[0]
            delivered.push({
              text: block?.type === 'text' ? block.text : '',
              source: message.source.kind,
            })
          },
        },
      } as never),
    } as never)
    ctx.provide('sessionPersistence', {} as never)
    // 投递成功后服务会 `sessions.flush()`；没有应答者时它返回 false，整次投递被判失败。
    installFlushAck(ctx, { count: 0 })
    await ctx.plugin(ScheduleService)
  }

  options.answer?.(ctx, ledger)

  return {
    ctx,
    ledger,
    domain,
    root,
    issued,
    delivered,
    ...(scheduleSessionId === undefined ? {} : { scheduleSessionId }),
    calls: {
      read: probes.read.calls,
      write: probes.write.calls,
      send_email: probes.send_email.calls,
      mail: probes.mail.calls,
    },
  }
}

/** 让指定表写失败，其余正常。 */
export async function bootFault(table: string, options: BootOptions = {}): Promise<Harness> {
  const root = await newRoot()
  return await boot({ ...options, root, backend: rejectingBackend(root, table) })
}

export interface ToolCall {
  name: string
  args: Record<string, unknown>
  controller: AbortController
}

export function call(name: string, args: Record<string, unknown>, controller = new AbortController()): ToolCall {
  return { name, args, controller }
}

/**
 * 以 `callId: 'c1'` 走一遍真注册表。
 * `agent` 默认现造一个 —— E8 的逐会话分支要往同一个 session 上追加 `approval/policy`，
 * 所以那里必须把自己持有的 agent 传进来，否则追加完就随对象一起丢了。
 */
export async function execute(ctx: Context, target: ToolCall, agent: Agent = fakeAgent()) {
  return await ctx.tools.execute({
    callId: ToolCallId('c1'),
    name: target.name,
    arguments: target.args,
    agent,
    signal: target.controller.signal,
  })
}

/** 记录 ask 事件的假 answerer（全部 `allowed-once`），第 2 步用它验接缝。 */
export function fakeAnswerer(seen: ApprovalRequest[]) {
  return (ctx: Context) => {
    ctx.on('approval/request', (req) => {
      seen.push(req)
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    })
  }
}

/* -------------------------------------------------------------------------- */
/* 真 agent + 脚本化模型：第 5 步要跑完整的一轮重放，不能只看 followup 被调用过。 */
/* -------------------------------------------------------------------------- */

/** 一次模型请求的脚本条目。`{ holdBefore }` 在流出内容前先停住，直到测试放开 —— 用它制造「这一轮还没跑完」。 */
export type ScriptEntry = StreamChunk[] | { holdBefore: StreamChunk[] }

/** 一段纯文本回答的 chunk 序列 —— 形状抄内核自己的 `agent-loop/tests/mock-adapter.ts`。 */
export function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** 一次工具调用的 chunk 序列。`arguments` 原样序列化，键序由测试决定（E9 靠它）。 */
export function toolCallChunks(callId: string, name: string, args: Record<string, unknown>): StreamChunk[] {
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId(callId), name, argumentsDelta: argumentsJson.slice(0, 5) },
    { type: 'tool-call-delta', index: 0, id: ToolCallId(callId), argumentsDelta: argumentsJson.slice(5) },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(callId), name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/**
 * 脚本化的模型。产品里这一层是真 provider，测试里只能是假 ——
 * 但循环、inbox、dispatch、审批闸与台账全是真的，所以「批准 → 新 turn → 原样重放 → 执行一次」
 * 这条链是被真跑出来的，不是被断言出来的。
 */
export class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  #script: ScriptEntry[]
  #resume: (() => void) | undefined

  constructor(script: ScriptEntry[]) {
    super()
    this.#script = script
  }

  /** 放开当前停在 `{ holdBefore }` 的那次请求。 */
  release(): void {
    const resume = this.#resume
    this.#resume = undefined
    resume?.()
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.#script.shift()
    if (entry === undefined) throw new Error('ScriptedAdapter: 脚本已用尽')
    const chunks = Array.isArray(entry) ? entry : await this.#held(entry.holdBefore)
    for (const chunk of chunks) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }

  /**
   * 先把请求挂住，等测试放开再交出内容。
   * 停住在「还没产出任何块」这一刻是有意的：agent loop 此时已经拿到这个 async iterable，
   * 但会话仍然算「在跑」，正好用来造「批准落在忙的那一轮」。
   */
  async #held(chunks: StreamChunk[]): Promise<StreamChunk[]> {
    await new Promise<void>(resolve => { this.#resume = resolve })
    return chunks
  }
}

/**
 * 在已装好的组合上造一个**真 agent**（带真 inbox、真 turn、真 dispatch），
 * 挂载法与内核 `packages/core/agent-loop/tests/cancel.spec.ts:313` 相同。
 */
export async function createRealAgent(harness: Harness, id: string, adapter: ScriptedAdapter) {
  harness.ctx.llm.registerAdapter(['mock'], adapter)
  const handle = await harness.ctx.agents.create({
    sessionId: SessionId(id),
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  return handle
}

/** 往真 agent 的 inbox 里投一条用户消息并叫醒驱动（等价于产品侧的一次提问）。 */
export function askAgent(agent: Agent, text: string): void {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
}

/**
 * 注册一个 `session/flush` 应答者。
 *
 * 真实持久化后端是 `@deepseek-ai/dsh-session-persistence-jsonl`（本 harness 没装它，
 * 装了会把 zstd/koffi 那串原生依赖拖进来），而 `sessions.flush()` 的契约正是
 * 「至少有一个应答者确认过」。这里注册的监听器承担的就是那一个应答者的位置，
 * 并把确认次数留给测试断言 —— 「没有应答者 ⇒ flush 返回 false ⇒ 恢复路径必须报告」
 * 那条用例则故意不注册。
 */
export function installFlushAck(ctx: Context, acks: { count: number }): void {
  ctx.on('session/flush', () => {
    acks.count += 1
    return Promise.resolve()
  })
}

/**
 * 等到条件成立；轮询而不是猜时长。
 *
 * 期限 15 秒是 2026-10-17 去 flake 时定的：本文件与 `sweeper.spec.ts` 里等的是台账/内核里的
 * **事实**（不是墙钟），机器满载时 boot 与投递回执能吃掉好几秒，旧的 5 秒期限在并行跑时会偶发
 * 假红。放宽期限不掩盖真故障——真坏了就是永远不成立，一样到点抛。
 */
export const UNTIL_DEADLINE_MS = 15_000

export async function until(predicate: () => boolean, message = '条件始终没成立'): Promise<void> {
  const deadline = Date.now() + UNTIL_DEADLINE_MS
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

/** 真实时间流逝 —— 同步窗口与批件有效期都按真时钟判定，所以"等它过期"只能真的等。 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
