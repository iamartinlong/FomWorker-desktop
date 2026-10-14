/**
 * M1 风险闸的验收单测（设计 §8 第 2 步）。组合方式见 `test-harness.ts`。
 */

import { describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { argsDigest } from './ledger.ts'
import { builtinRiskRules, describeAction, riskLevelOf } from './risk-gate.ts'
import { boot, bootFault, call, escalated, execute, fakeAnswerer, gateRules } from './test-harness.ts'

const productRules = new Map(Object.entries(builtinRiskRules))

describe('risk-gate：ask 到审批服务的接缝（F7）', () => {
  it('L2 动作经 ask 走通，事件带 callId 与同一个 signal 对象，工具照常收到未改写的参数', async () => {
    const asked: ApprovalRequest[] = []
    const setup = await boot({ gateNow: () => 1_000, answer: fakeAnswerer(asked) })
    const target = call('send_email', { to: 'boss@corp.example', content: '周报已生成' })
    const result = await execute(setup.ctx, target)

    expect(result.isError).toBe(false)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ toolName: 'send_email', callId: 'c1' })
    // 不是「另一个 signal」，而是同引用 —— responder 要靠它挂窗口取消（§3.3）
    expect(asked[0]?.signal).toBe(target.controller.signal)
    expect(setup.calls.send_email).toEqual([{ to: 'boss@corp.example', content: '周报已生成' }])
  })

  it('ask 携带审计 reason 与 locale 文案，responder 不重组卡片正文（D8）', async () => {
    const asked: ApprovalRequest[] = []
    const setup = await boot({ gateNow: () => 1_000, answer: fakeAnswerer(asked) })
    await execute(setup.ctx, call('send_email', { to: 'boss@corp.example' }))
    expect(asked[0]?.reason).toBe('risk gate: L2 tool "send_email" requires human approval')
    expect(asked[0]?.displayReason).toMatchObject({
      zh: '这个动作会对外可见，需要你批准。',
      en: 'This action is visible outside the workspace and needs your approval.',
    })
  })

  it('提权类写调用落到 L3 被问；工作区内的幂等写不问（§5 的 D1：分级不用 never）', async () => {
    const asked: ApprovalRequest[] = []
    const setup = await boot({ gateNow: () => 1_000, answer: fakeAnswerer(asked) })
    await execute(setup.ctx, call('write', escalated))
    expect(asked).toHaveLength(1)
    expect(setup.calls.write).toHaveLength(1)

    await execute(setup.ctx, call('write', { file_path: '/workspace/a.md', content: 'x' }))
    expect(asked).toHaveLength(1)
    expect(setup.calls.write).toHaveLength(2)
  })

  it('未登记的工具按 L4 询问，而不是默认放行', async () => {
    const asked: ApprovalRequest[] = []
    const setup = await boot({ gateNow: () => 1_000, answer: fakeAnswerer(asked) })
    await execute(setup.ctx, call('mail', { to: 'boss@corp.example' }))
    expect(asked).toHaveLength(1)
    expect(asked[0]?.reason).toContain('risk gate: L4')
  })

  it('分级字典按参数二次判定，且原型链上的名字不算命中', () => {
    const rules = new Map(Object.entries(gateRules))
    expect(riskLevelOf('write', { file_path: '/workspace/a.md' }, rules)).toBe('L1')
    expect(riskLevelOf('write', escalated, rules)).toBe('L3')
    expect(riskLevelOf('read', {}, rules)).toBe('L0')
    expect(riskLevelOf('constructor', {}, rules)).toBe('L4')
    expect(riskLevelOf('toString', {}, rules)).toBe('L4')
  })
})

describe('risk-gate：L0/L1 不独占 waterfall', () => {
  it('低风险调用交棒给后续监听器，高风险调用拦住不让后续监听器代答', async () => {
    const asked: ApprovalRequest[] = []
    const setup = await boot({ gateNow: () => 1_000, answer: fakeAnswerer(asked) })
    const reached: string[] = []
    setup.ctx.on('tools/pre-execute', async (exec, next) => {
      reached.push(exec.name)
      return await next()
    })

    await execute(setup.ctx, call('read', { file_path: '/workspace/a.md' }))
    await execute(setup.ctx, call('write', { file_path: '/workspace/b.md', content: 'x' }))
    expect(reached).toEqual(['read', 'write'])

    reached.length = 0
    await execute(setup.ctx, call('send_email', { to: 'boss@corp.example' }))
    expect(reached).toEqual([])
    expect(asked).toHaveLength(1)
  })
})

describe('risk-gate：ask 快照取自被闸的那次调用（§3.4.1②）', () => {
  it('responder 手上的 callId 能换回带参数的记录，时间窗按级别收紧', async () => {
    const asked: ApprovalRequest[] = []
    const setup = await boot({ gateNow: () => 1_000, answer: fakeAnswerer(asked) })
    await execute(setup.ctx, call('write', escalated))

    const record = setup.ledger.findByCall(asked[0]!.callId!)
    expect(record).toMatchObject({
      requestId: 'req-gate-1',
      sessionId: 'office-approval-session',
      tenantId: 'tenant-1',
      toolName: 'write',
      riskLevel: 'L3',
      actionSummary: '写入 C:\\Users\\demo\\report.docx',
      status: 'pending',
      askedAt: 1_000,
      windowEndsAt: 91_000,
      expiresAt: 1_000 + 4 * 60 * 60_000,
    })
    expect(record?.toolArgs).toEqual(escalated)
  })

  it('快照到授权到重放：模型换了 justification，digest 仍然命中', async () => {
    const asked: ApprovalRequest[] = []
    const setup = await boot({ gateNow: () => 1_000, answer: fakeAnswerer(asked) })
    await execute(setup.ctx, call('write', escalated))
    const record = setup.ledger.findByCall('c1')!

    // 回调路由（第 4 步）拿台账里的参数签发授权
    const approved = await setup.ledger.approve(record.requestId, {
      decidedBy: 'ou-alice',
      now: 2_000,
      grant: {
        grantId: 'g-1',
        toolName: record.toolName,
        argsDigest: argsDigest(record.toolArgs as Record<string, unknown>),
        grantExpiresAt: 10_000,
      },
    })
    expect(approved.won).toBe(true)

    // U1 实测：重放必然再问一次，且 11/11 重写 justification
    const replayed = { ...escalated, justification: '已获批准，按原参数重放这次写入' }
    expect(await setup.ledger.consumeGrant('write', argsDigest(replayed), 3_000)).toBeDefined()
  })

  it('低风险调用不落台账 —— 只读与幂等写不该在审批账本里留痕', async () => {
    const asked: ApprovalRequest[] = []
    const setup = await boot({ gateNow: () => 1_000, answer: fakeAnswerer(asked) })
    await execute(setup.ctx, call('read', { file_path: '/workspace/a.md' }))
    await execute(setup.ctx, call('write', { file_path: '/workspace/b.md', content: 'x' }))
    expect(setup.issued).toEqual([])
    expect(asked).toHaveLength(0)
  })

  it('快照活过进程重启 —— 延迟批准整条链路的前提（E3 在闸这一层的形态）', async () => {
    const asked: ApprovalRequest[] = []
    const first = await boot({ gateNow: () => 1_000, answer: fakeAnswerer(asked) })
    await execute(first.ctx, call('write', escalated))
    await first.ctx.fiber.dispose()

    const second = await boot({ root: first.root, gateNow: () => 1_000, answer: fakeAnswerer([]) })
    const record = second.ledger.findByCall('c1')
    expect(record).toMatchObject({ requestId: 'req-gate-1', riskLevel: 'L3', status: 'pending' })
    expect(record?.toolArgs).toEqual(escalated)
  })
})

describe('risk-gate：异常一律走拒绝（铁律：不改默认 fail-closed）', () => {
  it('E12 索引写不进台账 ⇒ 拒绝执行，不发询问、不 dispatch、不留半条记录', async () => {
    const asked: ApprovalRequest[] = []
    const setup = await bootFault('call_index', { gateNow: () => 1_000, answer: fakeAnswerer(asked) })
    const result = await execute(setup.ctx, call('write', escalated))

    expect(result.isError).toBe(true)
    expect(asked).toHaveLength(0)
    expect(setup.calls.write).toHaveLength(0)
    expect(setup.ledger.findByCall('c1')).toBeUndefined()
    expect(setup.ledger.get('req-gate-1')).toBeUndefined()
  })

  it('E12 记录本身写不进 ⇒ 同样拒绝', async () => {
    const asked: ApprovalRequest[] = []
    const setup = await bootFault('requests', { gateNow: () => 1_000, answer: fakeAnswerer(asked) })
    const result = await execute(setup.ctx, call('send_email', { to: 'boss@corp.example' }))
    expect(result.isError).toBe(true)
    expect(asked).toHaveLength(0)
    expect(setup.calls.send_email).toHaveLength(0)
  })

  it('解析不出租户时只交棒：不问、不拒、不写别人的账（§4）', async () => {
    const asked: ApprovalRequest[] = []
    const setup = await boot({
      gateNow: () => 1_000,
      tenantOf: () => undefined,
      answer: fakeAnswerer(asked),
    })
    await execute(setup.ctx, call('write', escalated))
    // 交棒后的结局由链条其余部分决定（本组合里 terminal 默认 allow），
    // 闸本身没有替这个会话作任何决定 —— 一租户一进程部署必须保证本租户的闸在链上。
    expect(asked).toHaveLength(0)
    expect(setup.issued).toEqual([])
    expect(setup.calls.write).toHaveLength(1)
  })

  it('没有 agent 的高危调用直接拒，且不发一次注定失败的询问', async () => {
    const asked: ApprovalRequest[] = []
    const setup = await boot({ gateNow: () => 1_000, answer: fakeAnswerer(asked) })
    const result = await setup.ctx.tools.execute({
      callId: ToolCallId('c1'),
      name: 'write',
      arguments: escalated,
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(true)
    expect(asked).toHaveLength(0)
    expect(setup.calls.write).toHaveLength(0)
  })
})

// 第 2 步的这套用例跑的是 `test-harness.ts` 里的**样例**字典，产品字典（`builtinRiskRules`）
// 一行都没被断言过 —— 「`ask_user_question` 也要一张 owner 批准卡」这种只在真字典上才暴露的问题，
// 因此一路活到第 8 步真人点击的现场（F-H）。这一整块钉的是**产品字典本身**。
describe('产品字典 · dsh web 内置工具集的分级（F-H）', () => {
  it('问人与只读类工具不打扰：L0 交棒，不落台账', () => {
    // `ask_user_question` 是回环的正解：它必须先不被问，模型才能问「要不要批」。
    for (const name of [
      'ask_user_question', 'read', 'glob', 'grep', 'skill', 'job_output', 'job_list',
      'get_goal', 'schedule_list', 'list_agents', 'list_mcp_resources', 'list_mcp_resource_templates',
    ]) expect(riskLevelOf(name, {}, productRules)).toBe('L0')
  })

  it('会话历史检索五把只读工具是 L0 —— 不登记就落 L4（F-6B）', () => {
    // 这五把由 `--patch` 挂入（`packages/session-query/tool-session-query/src/index.ts:65-121`），
    // 不在 dsh web 默认 profile ⇒ 漏登记就落「未知→L4」，真进程实测过一次 `session_search` 引记忆出处
    // 要一张 owner 批准卡、而自动化下被取消、工具从不执行（F-6B）。全是只读本地检索，与 read/glob/grep 同类。
    for (const name of [
      'session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read',
    ]) expect(riskLevelOf(name, {}, productRules)).toBe('L0')
  })

  it('飞书工具层：只读是 L0、写是 L2（设计小样：定名登记，不用 MCP 的动态名）', () => {
    // 只读飞书文档 = 本地不可见、无外部副作用 ⇒ L0（与 read/web_search 同档）；写飞书文档 = 对外可见 ⇒ L2。
    // 走自研定名工具而不是 MCP，正是为了能静态登记：MCP 的 `mcp__<server>__<tool>` 名字运行时生成、
    // 字典故意不登记 ⇒ 落 L4 ⇒ 每次读都批一张卡（F-6B 同病）。
    expect(riskLevelOf('feishu_doc_read', {}, productRules)).toBe('L0')
    expect(riskLevelOf('feishu_bitable_list_records', {}, productRules)).toBe('L0')
    expect(riskLevelOf('feishu_calendar_list_events', {}, productRules)).toBe('L0')
    expect(riskLevelOf('feishu_doc_create', {}, productRules)).toBe('L2')
    expect(riskLevelOf('feishu_bitable_create_record', {}, productRules)).toBe('L2')
    expect(riskLevelOf('feishu_calendar_create_event', {}, productRules)).toBe('L2')
  })

  it('只改本会话状态的工具也不打扰（L1），包括退出计划模式那次确认', () => {
    // `memory_write` / `memory_archive` / `memory_distill` 在这一群里（MU2 取的 L1）：记忆层的
    // 验收要求「记一条东西」与「跑一次夜间蒸馏」都不该产生审批卡（ME8），所以它们必须是 L1
    // 而不是 L2 —— 且不许降成 L0（降了就没有闸上留痕，蒸馏跑没跑过只剩自述）。
    for (const name of [
      'todo_write', 'present', 'read_image', 'create_goal', 'update_goal', 'exit_plan_mode',
      'memory_write', 'memory_archive', 'memory_distill',
    ]) {
      expect(riskLevelOf(name, {}, productRules)).toBe('L1')
    }
    // 二次确认这一步本身就是「把计划交给人看」，再叠一张卡就是问人两次同一个决定。
    expect(riskLevelOf('exit_plan_mode', { plan: '# x' }, productRules)).toBe('L1')
  })

  it('出网、驱动别的 agent、留下会自己触发的排程 ⇒ L2；不可逆或换沙箱 ⇒ L3', () => {
    for (const name of [
      'web_search', 'web_fetch', 'read_mcp_resource',
      'schedule_create', 'schedule_update', 'schedule_delete',
      'subagent', 'subagent_fork', 'send_message', 'interrupt_agent',
    ]) expect(riskLevelOf(name, {}, productRules)).toBe('L2')

    for (const name of ['workflow', 'job_kill', 'subagent_acp']) expect(riskLevelOf(name, {}, productRules)).toBe('L3')
    // 同一条 shell：不带提权参数是 L2，要求换沙箱模式就升到 L3（§3.4.1②：只看工具名分不出来）。
    expect(riskLevelOf('pwsh', { command: 'Get-Date' }, productRules)).toBe('L2')
    expect(riskLevelOf('pwsh', { command: 'Get-Date', sandbox_permissions: 'danger-full-access' }, productRules)).toBe('L3')
    expect(riskLevelOf('write', { file_path: 'C:\\Users\\demo\\workspace\\a.md' }, productRules)).toBe('L1')
    expect(riskLevelOf('write', escalated, productRules)).toBe('L3')
  })

  it('没登记的名字仍然是 L4，包括 MCP 的动态名与原型链上的名字', () => {
    expect(riskLevelOf('some_future_tool', {}, productRules)).toBe('L4')
    expect(riskLevelOf('mcp__github__create_issue', {}, productRules)).toBe('L4')
    expect(riskLevelOf('constructor', {}, productRules)).toBe('L4')
    expect(riskLevelOf('toString', {}, productRules)).toBe('L4')
  })

  it('卡片正文不许是裸工具名（§4）：登记过的带要点，没登记的直说没登记', () => {
    expect(describeAction('write', escalated, productRules)).toBe('写入 C:\\Users\\demo\\report.docx')
    expect(describeAction('web_fetch', { url: 'https://example.com/a' }, productRules)).toContain('https://example.com/a')
    expect(describeAction('pwsh', { command: 'Remove-Item x' }, productRules)).toBe('执行命令')

    const unknown = describeAction('some_future_tool', {}, productRules)
    expect(unknown).not.toBe('some_future_tool')
    expect(unknown).toContain('未识别的工具')
    // MCP 那一类是「未知」里最大的一坨，得说清它是外部服务器贡献的能力，不是内核的内置动作。
    const dynamic = describeAction('mcp__github__create_issue', {}, productRules)
    expect(dynamic).toContain('外部 MCP 工具')
    expect(dynamic).not.toBe('mcp__github__create_issue')
  })

  it('每一条可能问人的登记项都必须自带动作描述 —— 漏写就红，不许靠兜底文案上线', () => {
    const missing: string[] = []
    for (const [name, rule] of Object.entries(builtinRiskRules)) {
      const asks = typeof rule.level === 'function' || rule.level === 'L2' || rule.level === 'L3' || rule.level === 'L4'
      if (asks && rule.summarize === undefined) missing.push(name)
    }
    expect(missing).toEqual([])
  })

  it('产品字典装进真闸：同一条提权写照旧被问，只读照旧不问也不留痕', async () => {
    const asked: ApprovalRequest[] = []
    const setup = await boot({ rules: builtinRiskRules, gateNow: () => 1_000, answer: fakeAnswerer(asked) })

    await execute(setup.ctx, call('read', { file_path: '/workspace/a.md' }))
    expect(asked).toHaveLength(0)
    expect(setup.issued).toEqual([])

    await execute(setup.ctx, call('write', escalated))
    expect(asked).toHaveLength(1)
    expect(setup.issued).toEqual(['req-gate-1'])
    expect(setup.ledger.findByCall('c1')).toMatchObject({ riskLevel: 'L3', actionSummary: '写入 C:\\Users\\demo\\report.docx' })
  })
})
