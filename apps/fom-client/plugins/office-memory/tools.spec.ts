/**
 * `memory_write` / `memory_archive` 两把工具层的验收单测（设计 §7 第 2 步）。
 *
 * 走的是 `ToolDefinition.execute` 那条**真入口**：参数先过内核的 JSON Schema 校验，
 * 再进我们的 execute。所以这里同时验到三件事 —— schema 写得对不对（必填、enum 形状）、
 * 配对判定是否给得出模型可读的错误、store 的拒绝有没有原样传到模型面前。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createMemoryTools } from './tools.ts'
import { MemoryStore } from './store.ts'

const CLOCK = new Date('2026-10-10T09:00:00').getTime()
const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function harness() {
  return mkdtemp(join(tmpdir(), 'office-memory-tools-')).then(async dir => {
    dirs.push(dir)
    const store = new MemoryStore(join(dir, 'memories'), { now: () => CLOCK })
    return { dir, store, tools: createMemoryTools(store) }
  })
}

/** 只带 agent 身份的最小执行上下文：这两把工具只读 `exec.agent.session.id` 做溯源。 */
function exec(sessionId?: string): ToolRunContext {
  const agent = sessionId === undefined ? undefined : { session: { id: sessionId } }
  return {
    callId: ToolCallId('call-1'),
    rootCallId: ToolCallId('call-1'),
    name: 'memory_write',
    arguments: {},
    signal: new AbortController().signal,
    ...(agent === undefined ? {} : { agent }),
    deferContext: () => {},
    concludeTurn: () => {},
  } as unknown as ToolRunContext
}

const entry = {
  kind: 'entry',
  type: 'project',
  slug: 'q4-report',
  title: 'Q4 报告',
  hook: '结论先出，附表放最后',
  body: '老板要的是先给结论。',
  source: 'user',
}

describe('memory_write', () => {
  it('kind=entry 写成功，返回路径与索引线索，并把会话号存进溯源', async () => {
    const { dir, tools } = await harness()
    const result = await tools.write.execute({ ...entry }, exec('sess-7'))

    expect(result).toMatchObject({ kind: 'entry', path: 'project/q4-report.md' })
    const text = await readFile(join(dir, 'memories', 'project', 'q4-report.md'), 'utf8')
    expect(text).toContain('sourceSession: "sess-7"')
    expect(text).toContain('source: "user"')
  })

  it('没有 agent 身份时不写 sourceSession，而不是写一个空串', async () => {
    const { dir, tools } = await harness()
    await tools.write.execute({ ...entry }, exec())
    const text = await readFile(join(dir, 'memories', 'project', 'q4-report.md'), 'utf8')
    expect(text).not.toContain('sourceSession')
  })

  it('kind=daily 只追加流水，不产生条目文件', async () => {
    const { dir, store, tools } = await harness()
    const result = await tools.write.execute({ kind: 'daily', body: '今天定了报告口径' }, exec('sess-7'))

    expect(result).toMatchObject({ kind: 'daily', path: store.dailyPath() })
    expect(await readFile(join(dir, 'memories', store.dailyPath()), 'utf8')).toContain('- 今天定了报告口径')
    expect(await readFile(join(dir, 'memories', 'project', 'q4-report.md'), 'utf8').catch(() => undefined)).toBeUndefined()
  })

  it('kind=daily 混进条目字段被拒，错误里带着正确形状（条件必填 schema 表达不了）', async () => {
    const { tools } = await harness()
    const error = await tools.write.execute({ kind: 'daily', body: 'x', title: '不该有标题' }, exec('s'))
      .then(() => undefined, (e: unknown) => e as Error)
    expect(error?.message).toContain('kind=daily 不许带')
    expect(error?.message).toContain('kind=entry 需要')
  })

  it('kind=entry 缺必填字段由我们报错（给模型看正确形状），非法 kind 由 schema 拦在 execute 之前', async () => {
    const { tools } = await harness()
    const missing = await tools.write.execute({ kind: 'entry', type: 'project', body: 'x' }, exec('s'))
      .then(() => undefined, (e: unknown) => e as Error)
    expect(missing?.message).toContain('当前缺少 slug')

    // 非法的 `kind` 根本进不到 execute —— 这一条不是在测工具，是在记「谁在哪一层拦」：
    // schema 拦形状，execute 只拦语义（配对、越权、黑名单）。
    const unknown = await tools.write.execute({ kind: 'forever', body: 'x' }, exec('s'))
      .then(() => undefined, (e: unknown) => e as Error)
    expect(unknown?.message).toContain('"kind" must be one of')
  })

  it('参数 schema 由内核校验：目录类型不在四格里就进不到 execute', async () => {
    const { tools } = await harness()
    const error = await tools.write.execute({ ...entry, type: 'secrets' }, exec('s'))
      .then(() => undefined, (e: unknown) => e as Error)
    expect(String(error?.message)).toContain('"type" must be one of')
  })

  it('render 给的是给人看的一句话，不是裸 JSON', async () => {
    const { tools } = await harness()
    const result = await tools.write.execute({ ...entry }, exec('s'))
    const blocks = tools.write.output.render({ ...entry }, result as never)
    expect(blocks[0]).toMatchObject({ type: 'text', text: expect.stringContaining('project/q4-report.md') })
  })
})

describe('memory_archive', () => {
  it('归档成功：返回落点与「索引行有没有被撤」', async () => {
    const { dir, store, tools } = await harness()
    await tools.write.execute({ ...entry }, exec('s'))
    await readFile(join(dir, 'memories'), 'utf8').catch(() => undefined)
    const result = await tools.archive.execute({ path: 'project/q4-report.md', reason: '已结项' }, exec('s'))

    expect(result).toMatchObject({ archivedTo: 'archived/2026/project-q4-report.md', indexRemoved: false })
    expect(await readFile(join(dir, 'memories', 'project', 'q4-report.md'), 'utf8').catch(() => undefined)).toBeUndefined()
    expect(await store.readIndex()).toBe('')
  })

  // F-L：归档返回给模型的那句话必须自带「索引由夜间蒸馏整段重写、缺行不是故障、别手动补」的机制解释，
  // 否则模型看见索引里少了行会以为是坏了、自己去手写 MEMORY.md，正撞 ME10 的单一写者禁忌。
  it('归档 render 把「别修索引」的机制说给模型（F-L）', async () => {
    const { store, tools } = await harness()
    await tools.write.execute({ ...entry }, exec('s'))
    const result = await tools.archive.execute({ path: 'project/q4-report.md', reason: '已结项' }, exec('s'))
    const blocks = tools.archive.output.render({ path: 'project/q4-report.md', reason: '已结项' }, result as never)
    expect(blocks[0]).toMatchObject({ type: 'text', text: expect.stringContaining('夜间蒸馏') })
    expect(blocks[0]).toMatchObject({ type: 'text', text: expect.stringContaining('整段重写') })
    expect(blocks[0]).toMatchObject({ type: 'text', text: expect.stringContaining('不要') })
    expect(await store.readIndex()).toBe('')
  })

  it('越权三形原样传到模型面前：绝对路径、穿越、非条目目录', async () => {
    const { tools } = await harness()
    const cases: Array<[string, string]> = [
      ['../escape/x.md', '穿越段'],
      [join(process.env.SystemRoot ?? 'C:\\Windows', 'win.ini'), '绝对路径'],
      ['daily/2026-10-10.md', '只能归档'],
    ]
    for (const [path, expectText] of cases) {
      const error = await tools.archive.execute({ path, reason: '越界' }, exec('s'))
        .then(() => undefined, (e: unknown) => e as Error)
      expect(error?.message).toContain(expectText)
    }
  })
})
