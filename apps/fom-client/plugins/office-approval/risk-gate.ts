/**
 * M1 风险闸（设计 §5 分级表、§4 租户与失败取向、§3.4.1② 快照来源；§8 第 2 步）。
 *
 * 它挂在 `tools/pre-execute` 上，是这个平台唯一决定「这次调用要不要问人」的地方（D1/D2）：
 * 分级用 `ask` 表达，不自建一套旁路放行 —— `ask` 由内核去调 `approval.request()`，
 * 自动带上 `callId` 与 `exec.signal`（F7），我们不必自己保证这三件事。
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ApprovalLedger, ApprovalRequestRecord, RiskLevel } from './ledger.ts'

export interface RiskRule {
  /**
   * 静态分级，或按参数二次分级 —— 同一个 `write` 工具，写到工作区内是 L1，
   * 写到工作区外是不可逆的 L3，只看工具名分不出来。
   */
  readonly level: RiskLevel | ((args: unknown) => RiskLevel)
  /** 给人看的动作描述。原始参数只进台账，不进卡片正文（§4 最小暴露）。 */
  readonly summarize?: (args: unknown) => string
}

export type RiskRuleTable = Readonly<Record<string, RiskRule>>

/** 带提权重试参数的调用就是在要求换沙箱模式，与它写到哪儿无关。 */
function escalated(args: unknown): boolean {
  return (args as { sandbox_permissions?: string }).sandbox_permissions !== undefined
}

/** 同一个 `write`，工作区内是 L1，带提权是要换沙箱的 L3，写到 `outbox/` 等于发出去一次（L2）。 */
function classifyFile(filePath: string | undefined, permissions: string | undefined): 'L1' | 'L2' | 'L3' {
  if (permissions !== undefined) return 'L3'
  if (filePath !== undefined && /(^|[\\/])outbox[\\/]/.test(filePath)) return 'L2'
  return 'L1'
}

/**
 * §5 分级字典在 dsh web 产品形态下的**完整覆盖**（F-H）。
 *
 * 补全的动机不是 convenience，而是那条「未知工具 → L4」的保守默认会在真实工具集上天天误伤：
 * `ask_user_question` 因此要一张「影响整个租户，需要 owner 批准」的卡（模型要先获批才能问要不要批），
 * `todo_write` / `present` / `schedule_list` 这些会话内动作也一样。每一行的名字都逐条核对自内核的
 * `defineTool` 注册处（注释里给 `文件:行`），归类只看**实现有没有外部副作用**，不看描述文案：
 *
 * - **L0** 只读、无落盘、无出网、不改状态。
 * - **L1** 只改本会话的持久态（幂等、可被下一次调用覆盖，且不会自己发起动作）。
 * - **L2** 对外可见：出网、驱动别的 agent、或留下会在之后触发外部动作的排程。
 * - **L3** 不可逆 / 要求换沙箱模式（卡片带二次确认，`expiresAt` 4 小时）。
 *
 * 故意**不在**这张表里的：`mcp__<server>__<tool>` 形态的动态名 —— 名字由远端服务器在运行时生成，
 * 天生无法静态登记，落回默认 L4 正是想要的（§5「未知工具按 L4」）。这条纪律优先于「少打扰」。
 */
export const builtinRiskRules: RiskRuleTable = {
  // 只读，L0：`packages/fs/tool-fs/src/read.ts:78`、`tool-fs-search/src/{glob.ts:307,grep.ts:285}`
  read: { level: 'L0' },
  glob: { level: 'L0' },
  grep: { level: 'L0' },
  // 会话历史检索五把（`packages/session-query/tool-session-query/src/index.ts:65-121`，全部只读：
  // 搜历史会话 / 搜单会话事件 / 读会话谱系 / 读事件替换链 / 读单条完整事件），无写盘、无出网、无外部动作。
  // F-6B：这五把不在 dsh web 默认 profile，是我们用 `--patch` 挂进来的 —— 补这一组的动机与 F-H 同源：
  // 不登记就落「未知 → L4」，模型一调 `session_search` 引记忆出处就要一张 owner 批准卡（自动化下无人应答、
  // 工具从不执行）。只读本地检索与 `read`/`glob`/`grep` 同类，故是 L0 而非 L1/L2。
  session_search: { level: 'L0' },
  session_event_search: { level: 'L0' },
  session_trace: { level: 'L0' },
  session_event_trace: { level: 'L0' },
  session_event_read: { level: 'L0' },
  // 飞书工具层（`plugins/office-feishu/tools.ts`，设计小样 §2）：只读飞书文档 = 本地不可见、无外部副作用 = L0。
  // F-6B 同类：这把我们自己挂进来的**定名**工具若不登记就落「未登记 → L4」（每次读都批一张卡）；
  // 走自研定名工具而不是 MCP，正是为了能静态登记（MCP 的 `mcp__<server>__<tool>` 名字运行时生成、无法登记）。
  feishu_doc_read: { level: 'L0' },
  // 列出多维表格记录 = 只读（本地不可见、无外部副作用）= L0。
  feishu_bitable_list_records: { level: 'L0' },
  // 列出日历日程 = 只读 = L0。
  feishu_calendar_list_events: { level: 'L0' },
  // 写飞书文档 = 对外可见 = L2（与 `web_search` / `schedule_create` 同档；写工具会问人批准）。
  feishu_doc_create: { level: 'L2', summarize: args => `新建飞书文档「${(args as { title?: string }).title ?? ''}」` },
  // 写多维表格记录 / 建日历日程 = 对外可见 = L2。
  feishu_bitable_create_record: { level: 'L2', summarize: () => '往多维表格写一条记录' },
  feishu_calendar_create_event: { level: 'L2', summarize: args => `建日历日程「${(args as { summary?: string }).summary ?? ''}」` },
  // 读图会把图存进本会话附件（`tool-fs/src/read-image.ts:210`），是幂等的会话内写，不是纯读。
  read_image: { level: 'L1' },
  // 问人本身（`packages/interaction/tool-ask-user/src/{index.ts:39,timed.ts:107}`，两个实现同名）：
  // 纯 UI 往返，不写盘、不出网。F-H 的回环就是这一条 —— 它必须登记，否则「先获批才能问要不要批」。
  ask_user_question: { level: 'L0' },
  // 读自身状态（`tool-jobs/src/index.ts:311,352`、`tool-goal/src/index.ts:196`、
  // `tool-schedule/src/index.ts:484`、`tool-subagent-control/src/list-agents.ts:87`、
  // `mcp-resources/src/tools.ts:34,43`、`tool-skill/src/index.ts:82`）
  job_output: { level: 'L0' },
  job_list: { level: 'L0' },
  get_goal: { level: 'L0' },
  schedule_list: { level: 'L0' },
  list_agents: { level: 'L0' },
  list_mcp_resources: { level: 'L0' },
  list_mcp_resource_templates: { level: 'L0' },
  // 载入 SKILL.md 会把指令注进上下文（`tool-skill/src/index.ts:82`），但那是操作者装好的本地文件，
  // 不产生外部动作，所以是只读而不是审批对象。
  skill: { level: 'L0' },
  // 会话内状态写：todo 投影（`tool-todo/src/index.ts:136`）、交付物声明（`tool-present/src/index.ts:39`）、
  // goal 状态（`tool-goal/src/index.ts:208,235`）—— 幂等、可覆盖、自己不会发起任何动作。
  todo_write: { level: 'L1' },
  present: { level: 'L1' },
  create_goal: { level: 'L1' },
  update_goal: { level: 'L1' },
  // 退出计划模式本身就是「把计划交给人看」的那一步（`packages/plan/plan-mode/src/index.ts:66`）。
  // 再给它叠一张审批卡，就是问人要两次同一个决定 —— 与 ask_user_question 同一类回环。
  exit_plan_mode: { level: 'L1' },
  // 文件写与 shell：按参数二次判定（§3.4.1②）。
  write: {
    level: args => classifyFile((args as { file_path?: string }).file_path, (args as { sandbox_permissions?: string }).sandbox_permissions),
    summarize: args => `写入 ${(args as { file_path?: string }).file_path ?? '?'}`,
  },
  edit: {
    level: args => classifyFile((args as { file_path?: string }).file_path, (args as { sandbox_permissions?: string }).sandbox_permissions),
    summarize: args => `编辑 ${(args as { file_path?: string }).file_path ?? '?'}`,
  },
  // `packages/shell/tool-bash/src/index.ts:375`、`tool-pwsh/src/index.ts:385`：任意命令执行。
  bash: { level: args => escalated(args) ? 'L3' : 'L2', summarize: () => '执行命令' },
  pwsh: { level: args => escalated(args) ? 'L3' : 'L2', summarize: () => '执行命令' },
  // 出网：查询词与 URL 都会离开这台机器（`packages/web/tool-web/src/{search.ts:326,fetch.ts:457}`）。
  // 按 §5「对外可见」是 L2。**这是一条会被日常使用感质疑的判定**，见设计 §9 U11：
  // 想让它不打扰，正确出路是聚合审批（U6）或显式白名单配置，而不是把它悄悄写回 L0。
  web_search: { level: 'L2', summarize: args => `联网检索 ${(args as { queries?: string[] }).queries?.[0] ?? ''}` },
  web_fetch: { level: 'L2', summarize: args => `抓取网页 ${(args as { url?: string }).url ?? '?'}` },
  // 外部 MCP 资源读取同样出网（`packages/mcp/mcp-resources/src/tools.ts:52`）。
  read_mcp_resource: { level: 'L2', summarize: args => `读取外部资源 ${(args as { uri?: string }).uri ?? '?'}` },
  // 排程：现在这一次调用不改外部世界，但它留下了一个会在之后自己触发投递的东西
  // （`packages/schedule/tool-schedule/src/index.ts:446,505,531`）。
  schedule_create: { level: 'L2', summarize: args => `安排一次后续提醒 ${(args as { prompt?: string }).prompt?.slice(0, 40) ?? ''}` },
  schedule_update: { level: 'L2', summarize: () => '改动一条已安排的提醒' },
  schedule_delete: { level: 'L2', summarize: () => '取消一条已安排的提醒' },
  // 驱动别的 agent：它自己会调工具，而那些工具仍会逐个过这道闸，所以这里的风险是「放大」而不是「绕过」
  // （`tool-subagent/src/index.ts:380`、`tool-subagent-control/src/index.ts:29,75`）。
  subagent: { level: 'L2', summarize: args => `派生子 agent 执行「${(args as { description?: string }).description ?? ''}」` },
  subagent_fork: { level: 'L2', summarize: () => '派生一个分叉的子 agent' },
  subagent_acp: { level: 'L3', summarize: () => '把任务交给外部 ACP agent 执行' },
  send_message: { level: 'L2', summarize: () => '给另一个 agent 发指令' },
  interrupt_agent: { level: 'L2', summarize: () => '打断另一个 agent 正在跑的一轮' },
  // 多 agent 编排与杀作业是不可逆的放大（`tool-workflow/src/index.ts:329`、`tool-jobs/src/index.ts:372`）。
  workflow: { level: 'L3', summarize: args => `编排一批子 agent「${(args as { name?: string }).name ?? ''}」` },
  job_kill: { level: 'L3', summarize: () => '终止一个正在跑的后台作业' },
  // 记忆层的自研工具（`office-memory/tools.ts`）。MU2 的争议原样记在这儿：
  // 判 L1 的理由是「写在 memoryRoot 内、幂等、对外不可见」；判 L2 的理由是「写进 `feedback`
  // 会改变以后所有回合的行为，影响面比一次写文件大」。第一版取 L1，但**不许悄悄降成 L0** ——
  // L0 意味着连台账都不留，而 §3.2 那套 `sourceSession` / `createdAt` 溯源全靠这次落盘。
  // 这一行也必须被字典断言钉住（F-H 的教训：字典不被断言时，全绿保护的不是产品会加载的那张表）。
  memory_write: { level: 'L1', summarize: args => `记一条记忆 ${(args as { title?: string }).title ?? (args as { body?: string }).body?.slice(0, 40) ?? ''}` },
  memory_archive: { level: 'L1', summarize: args => `归档一条记忆 ${(args as { path?: string }).path ?? ''}` },
  // §3.6④ 对第三把工具同样成立：照常登记、走同一条 pre-execute waterfall，没有后门，也不降 L0。
  // 判 L1 的效果就是 ME8 的机制本体：蒸馏进程的 `workspaceRoot` 即 `memoryRoot`（DM7），
  // L1 直接交棒 ⇒ 夜里零张审批卡 —— 若判 L2+，没人点卡的蒸馏会被闸拦下，夜间链路整条断掉。
  memory_distill: { level: 'L1', summarize: () => '跑一次夜间记忆蒸馏' },
}

/** §5：未知工具按 L4 处理 —— 分不出风险的动作不能默认它是安全的。 */
export function riskLevelOf(toolName: string, args: unknown, rules: ReadonlyMap<string, RiskRule>): RiskLevel {
  const rule = rules.get(toolName)
  if (rule === undefined) return 'L4'
  return typeof rule.level === 'function' ? rule.level(args) : rule.level
}

/**
 * 卡片正文（§4 最小暴露 + 人因文案）。裸工具名是不合格的：审批人看不出「`mail`」是要发什么、
 * 发给谁，只能凭名字猜 —— 而猜错的方向是放行。登记过却漏写描述的工具同理。
 */
export function describeAction(toolName: string, args: unknown, rules: ReadonlyMap<string, RiskRule>): string {
  const rule = rules.get(toolName)
  if (rule?.summarize !== undefined) return rule.summarize(args)
  if (rule !== undefined) return `执行 ${toolName}`
  // MCP 动态名（`mcp__<server>__<tool>`，`packages/mcp/mcp-client/src/index.ts:57`）是「未知」里最大的一类，
  // 值得单独说清楚：它不是内核内置能力，是远端服务器在运行时贡献的。
  if (toolName.startsWith('mcp__')) return `外部 MCP 工具 ${toolName}（未登记，按最高风险处理）`
  return `未识别的工具 ${toolName}（默认按最高风险处理）`
}

/** D3：同步窗口默认 90 秒，窗口内没结果就作废本次询问（不是拒绝）。 */
export const defaultWindowMs = 90_000

/** §3.5：`expiresAt` 是安全阀，默认 24 小时，L3/L4 收紧到 4 小时。 */
export const defaultExpiresMs: Readonly<Partial<Record<RiskLevel, number>>> = {
  L2: 24 * 60 * 60_000,
  L3: 4 * 60 * 60_000,
  L4: 4 * 60 * 60_000,
}

const askPrompts: Record<'L2' | 'L3' | 'L4', { readonly en: string; readonly zh: string }> = {
  L2: { en: 'This action is visible outside the workspace and needs your approval.', zh: '这个动作会对外可见，需要你批准。' },
  L3: { en: 'This action cannot be undone and needs your approval.', zh: '这个动作不可逆，需要你批准。' },
  L4: { en: 'This action affects the whole tenant and needs the owner to approve.', zh: '这个动作影响整个租户，需要 owner 批准。' },
}

export interface TenantScope {
  readonly tenantId: string
}

export interface RiskGateOptions {
  ledger: ApprovalLedger
  rules: RiskRuleTable
  /**
   * 会话 → 租户。解析不出来时必须交棒（`next()`）：既不能放行（那是别的租户的
   * 高危动作），也不能替它拒绝（那会污染它的审计）—— §4。
   */
  tenantOf: (sessionId: string) => TenantScope | undefined
  newRequestId?: () => string
  windowMs?: number
  expiresMs?: Partial<Record<RiskLevel, number>>
  now?: () => number
  /**
   * **闸的适用范围**（缺省/空 ⇒ 全量，＝ M1 行为）：非空时**只闸这些工具名**，
   * 其余一律 `next()` 交棒（交回内核自己的闸/沙箱，不是放行）。
   *
   * 存在的理由：桌面形态下内置工具里的「对外可见」类（`web_search`/`web_fetch`）按产品字典也是 L2，
   * 一桌面一用户时就成了「搜一次问一次」的摩擦（§9 U11）。**产品层只闸自己的产品工具**，
   * 内置工具交回内核自己的闸 —— 这既不是「悄悄写回 L0」（内核那道闸照旧在），也不是放宽产品红线。
   */
  gatedTools?: readonly string[]
}

export function createRiskGate(options: RiskGateOptions) {
  // 用 Map 而不是直接索引：工具名是模型可控的字符串，`rules['constructor']`
  // 这种原型链上的命中会被当成一条规则。
  const rules = new Map(Object.entries(options.rules))
  const scope = options.gatedTools === undefined || options.gatedTools.length === 0
    ? undefined
    : new Set(options.gatedTools)
  const now = options.now ?? (() => Date.now())
  const windowMs = options.windowMs ?? defaultWindowMs
  const newRequestId = options.newRequestId ?? (() => randomUUID())

  return async function riskGate(
    exec: Readonly<ToolExecution>,
    next: () => Promise<PreToolDecision>,
  ): Promise<PreToolDecision> {
    // 范围过滤在分级之前：不在范围内 ⇒ 交棒（不是放行，后面还有内核自己的闸）。
    if (scope !== undefined && !scope.has(exec.name)) return await next()
    const level = riskLevelOf(exec.name, exec.arguments, rules)
    // L0/L1 交棒而不是返回 `allow`：waterfall 里返决策即独占，会把后面更严的闸挤掉（F1）。
    if (level === 'L0' || level === 'L1') return await next()

    const agent = exec.agent
    // 没有 agent 就没有路由与审计归属。内核在这种 ask 上也是拒（`serviceAsk`），
    // 这里提前拒掉是同一事实，且省掉一次注定失败的询问。
    if (agent === undefined) {
      return { kind: 'deny', reason: `tool "${exec.name}" is rated ${level} but the call has no agent to route approval through` }
    }

    const tenant = options.tenantOf(agent.session.id)
    if (tenant === undefined) return await next()

    const askedAt = now()
    const record: ApprovalRequestRecord = {
      requestId: newRequestId(),
      sessionId: agent.session.id,
      callId: exec.callId,
      rootCallId: exec.rootCallId,
      tenantId: tenant.tenantId,
      toolName: exec.name,
      riskLevel: level,
      actionSummary: describeAction(exec.name, exec.arguments, rules),
      toolArgs: exec.arguments,
      // 台账只存一份文案：重启后凭它重建卡片时，产品语言就是中文；
      // 询问事件里仍然透传完整的 locale 表（D8）。
      displayReason: askPrompts[level].zh,
      status: 'pending',
      askedAt,
      windowEndsAt: askedAt + windowMs,
      expiresAt: askedAt + (options.expiresMs?.[level] ?? defaultExpiresMs[level] ?? defaultExpiresMs.L2!),
      decidedBy: null,
      decidedAt: null,
    }

    try {
      await options.ledger.snapshot(record)
    } catch (error) {
      // E12 在闸这一层：台账落不下就等于无法留痕，无法留痕就不能放行。
      const reason = error instanceof Error ? error.message : String(error)
      return { kind: 'deny', reason: `tool "${exec.name}" is rated ${level} and its approval could not be recorded: ${reason}` }
    }

    return {
      kind: 'ask',
      reason: `risk gate: ${level} tool "${exec.name}" requires human approval`,
      displayReason: askPrompts[level],
    }
  }
}

/** 以全局监听器挂载（一租户一进程部署下，租户判定在监听器内部完成）。 */
export function installRiskGate(ctx: Context, options: RiskGateOptions): () => boolean {
  return ctx.on('tools/pre-execute', createRiskGate(options))
}
