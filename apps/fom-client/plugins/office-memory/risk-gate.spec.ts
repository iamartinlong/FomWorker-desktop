/**
 * 记忆层三把工具**接在产品风险闸上**的验收（设计 §3.6③④、ME8 的前提；§7 第 2 步要求的
 * 「字典级断言」的另半边 —— 字典表本身由 `../office-approval/risk-gate.spec.ts` 钉；
 * 第三把 `memory_distill` 是第 6 步 A2 补的蒸馏触发口）。
 *
 * 这里不用探针，而是把**真工具**注册进真 `ToolRuntime`、走真 `tools/pre-execute` waterfall：
 * 「L1 不打扰」这句话只有在这条链上才算验过 —— 单元里断言 `riskLevelOf(...)==='L1'`
 * 只能证明字典写了 L1，证明不了工具没有另开一条放行分支（§3.6④ 恰恰禁止那条分支）。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { builtinRiskRules, describeAction, riskLevelOf } from '../office-approval/risk-gate.ts'
import { boot, call, escalated, execute, fakeAnswerer } from '../office-approval/test-harness.ts'
import { createMemoryTools } from './tools.ts'
import { MemoryRunLedger, memoryRunDomain } from './run-ledger.ts'
import { MemoryStore } from './store.ts'

const productRules = new Map(Object.entries(builtinRiskRules))
const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** 真闸 + 真台账 + 真工具 + 真临时记忆目录。 */
async function bootMemory(rules = builtinRiskRules) {
  const dir = await mkdtemp(join(tmpdir(), 'office-memory-gate-'))
  dirs.push(dir)
  const memoryRoot = join(dir, 'memories')
  const asked: ApprovalRequest[] = []
  const setup = await boot({ rules, gateNow: () => 1_000, answer: fakeAnswerer(asked) })
  const tools = createMemoryTools(new MemoryStore(memoryRoot))
  setup.ctx.tools.register(tools.write)
  setup.ctx.tools.register(tools.archive)
  return { dir, memoryRoot, asked, setup, tools }
}

const writeArgs = {
  kind: 'entry',
  type: 'project',
  slug: 'q4-report',
  title: 'Q4 报告',
  hook: '结论先出',
  body: '老板要的是先给结论。',
  source: 'user',
}

describe('记忆工具在产品闸上（§3.6③：登记 L1，不是豁免）', () => {
  it('memory_write 不打扰、不落台账，文件真落进记忆目录', async () => {
    const { memoryRoot, asked, setup } = await bootMemory()
    const result = await execute(setup.ctx, call('memory_write', writeArgs))

    expect(result.isError).toBe(false)
    expect(asked).toHaveLength(0)
    expect(setup.issued).toEqual([])
    expect(setup.ledger.findByCall('c1')).toBeUndefined()
    expect(await readFile(join(memoryRoot, 'project', 'q4-report.md'), 'utf8')).toContain('结论先出')
  })

  it('memory_archive 同样不打扰', async () => {
    const { asked, setup } = await bootMemory()
    await execute(setup.ctx, call('memory_write', writeArgs))
    const result = await execute(setup.ctx, call('memory_archive', { path: 'project/q4-report.md', reason: '已结项' }))

    expect(result.isError).toBe(false)
    expect(asked).toHaveLength(0)
    expect(setup.issued).toEqual([])
  })

  it('双侧的另一半：加了记忆层之后，工作区外的提权写照旧出一张 L3 卡', async () => {
    const { asked, setup } = await bootMemory()
    await execute(setup.ctx, call('memory_write', writeArgs))
    await execute(setup.ctx, call('write', escalated))

    expect(asked).toHaveLength(1)
    expect(asked[0]?.toolName).toBe('write')
    expect(setup.issued).toEqual(['req-gate-1'])
    // 分级在台账那侧（`approval/request` 事件里没有 `riskLevel`，M1 §8 第 2 步已记过）。
    expect(setup.ledger.findByCall('c1')).toMatchObject({ riskLevel: 'L3' })
  })

  it('「不打扰」来自字典那一行，不来自工具里的放行分支：把它改成 L2 就立刻被问', async () => {
    // 这一条是 §3.6④ 的反例测试。若哪天有人给记忆工具加一条 `if (name.startsWith('memory_')) return next()`，
    // 这张表就还会红 —— 因为放行从来不该由工具自己说。
    const { asked, setup } = await bootMemory({ ...builtinRiskRules, memory_write: { level: 'L2', summarize: () => '记一条记忆' } })
    const result = await execute(setup.ctx, call('memory_write', writeArgs))

    expect(result.isError).toBe(false)
    expect(asked).toHaveLength(1)
    expect(setup.issued).toEqual(['req-gate-1'])
  })

  it('字典里两把工具都是 L1，且卡片正文不是裸工具名（§4 人因）', () => {
    expect(riskLevelOf('memory_write', writeArgs, productRules)).toBe('L1')
    expect(riskLevelOf('memory_archive', { path: 'project/q4-report.md' }, productRules)).toBe('L1')
    expect(describeAction('memory_write', writeArgs, productRules)).toBe('记一条记忆 Q4 报告')
    expect(describeAction('memory_archive', { path: 'project/q4-report.md' }, productRules)).toBe('归档一条记忆 project/q4-report.md')
    // 没带 title 时退回正文摘要，卡片仍然可读。
    expect(describeAction('memory_write', { kind: 'daily', body: '今天定了报告口径' }, productRules)).toContain('今天定了报告口径')
  })
})

/**
 * 第三把工具 `memory_distill` 的闸上验收（§7 第 6 步 A2，ME8 的机制本体）。
 *
 * 蒸馏进程夜里没有人类应答者：只要 `memory_distill` 被判 L2+，闸就会发一张没人点的卡，
 * 整条夜间链路停摆 —— 所以「走真闸而不打扰」这句话对这把工具比对写工具更贵。
 * 这里执行的是**真** `distillOnce`（真台账、真临时目录）：空记忆目录没有新日级 ⇒ no-op，
 * 对账行落在 `office_memory_run`，而审批台账与 `approval/request` 必须一个字节都没动。
 */
async function bootDistillerTools(rules = builtinRiskRules) {
  const dir = await mkdtemp(join(tmpdir(), 'office-memory-distill-gate-'))
  dirs.push(dir)
  const memoryRoot = join(dir, 'memories')
  const asked: ApprovalRequest[] = []
  const setup = await boot({ rules, gateNow: () => 1_000, answer: fakeAnswerer(asked) })
  const store = new MemoryStore(memoryRoot)
  const runLedger = new MemoryRunLedger(await setup.ctx.storageDomain.open(memoryRunDomain))
  const tools = createMemoryTools(store, runLedger)
  setup.ctx.tools.register(tools.write)
  setup.ctx.tools.register(tools.archive)
  setup.ctx.tools.register(tools.distill)
  return { dir, memoryRoot, asked, setup, store, runLedger, tools }
}

describe('memory_distill 在产品闸上（§3.6④：第三把也登记，没有后门）', () => {
  it('字典判 L1，卡片正文是动作句不是裸工具名（§4）', () => {
    expect(riskLevelOf('memory_distill', {}, productRules)).toBe('L1')
    const summary = describeAction('memory_distill', {}, productRules)
    expect(summary).toBe('跑一次夜间记忆蒸馏')
    expect(summary).not.toBe('memory_distill')
  })

  it('真闸上执行 memory_distill：不打扰、不落审批台账，蒸馏真跑过（对账行 no-op）', async () => {
    const { asked, setup, runLedger } = await bootDistillerTools()
    const result = await execute(setup.ctx, call('memory_distill', {}))

    expect(result.isError).toBe(false)
    expect(asked).toHaveLength(0)
    expect(setup.issued).toEqual([])
    expect(setup.ledger.findByCall('c1')).toBeUndefined()
    // 「没发卡」不等于「没执行」：蒸馏的对账行证明工具真的走完了确定性半边。
    expect(runLedger.latest()).toMatchObject({ outcome: 'no-op', archived: 0, indexLines: 0 })
  })

  it('双侧的另一半：蒸馏角色装好三把工具后，工作区外的提权写照旧出一张 L3 卡', async () => {
    const { asked, setup } = await bootDistillerTools()
    await execute(setup.ctx, call('memory_distill', {}))
    await execute(setup.ctx, call('write', escalated))

    expect(asked).toHaveLength(1)
    expect(asked[0]?.toolName).toBe('write')
    expect(setup.issued).toEqual(['req-gate-1'])
    expect(setup.ledger.findByCall('c1')).toMatchObject({ riskLevel: 'L3' })
  })

  it('「不打扰」同样只来自字典：把 memory_distill 改成 L2 就立刻被问（§3.6④ 反例）', async () => {
    const { asked, setup } = await bootDistillerTools(
      { ...builtinRiskRules, memory_distill: { level: 'L2', summarize: () => '跑一次夜间记忆蒸馏' } },
    )
    const result = await execute(setup.ctx, call('memory_distill', {}))

    expect(result.isError).toBe(false)
    expect(asked).toHaveLength(1)
    expect(setup.issued).toEqual(['req-gate-1'])
  })
})
