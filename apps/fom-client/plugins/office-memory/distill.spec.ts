/**
 * Deep Dream 蒸馏的验收单测（设计 §7 第 5 步）。覆盖三条守卫与 DM8 幂等：
 *
 * - **ME2 手改保护**：蒸馏只读不改条目正文，且**绝不淘汰 handEdited 的条目**——预算与
 *   「不动人手改的内容」冲突时让预算输（`guardedSkips` 计这类越线仍留下的条目）。
 * - **ME3 幂等 / 加法**：水位线丢失后重蒸不新增、不重写已有条目（`writeEntry` 的 `wx` 是执行手段），
 *   索引重建是磁盘现算的确定函数 ⇒ 文件集与索引行集不变。
 * - **ME10 单写者 / 不悬空**：`MEMORY.md` 只被整段覆盖；被淘汰条目的文件移进 archived/ 后，
 *   索引里**不留**指向它的行。
 * - **DM8 水位线**：没有新日级 ⇒ 一条不写、索引字节不动、记一条 no-op（成功，不是没跑）。
 *
 * 编排（`distillOnce`）跑真临时目录 + 真 `storage-json` 台账；打分与淘汰计划（`planDistill`）是纯函数，
 * 直接喂合成条目断言次序与守卫。与审批层同一条纪律：守卫就是文件与落盘行为，mock 掉等于没测。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { MemoryStore, indexLineFor, type EntryDraft, type ReadEntry } from './store.ts'
import { ageDaysOf, distillOnce, planDistill, renderIndex } from './distill.ts'
import { MemoryRunLedger, memoryRunDomain, runIdOf } from './run-ledger.ts'

const CLOCK = new Date('2026-10-10T09:00:00Z').getTime()
const DAY_MS = 86_400_000
const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  // Windows 上递归删与仍在飞的写会撞 ENOTEMPTY：给几次重试（2026-10-17 去 flake）。
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function newStoreDir(): Promise<{ store: MemoryStore, dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'office-distill-'))
  roots.push(dir)
  return { store: new MemoryStore(join(dir, 'memories'), { now: () => CLOCK }), dir }
}

/** 装出真存储栈并开 `office_memory_run` 域——顺带证明这个域名（下划线）能被内核接受。 */
async function bootLedger(dir: string): Promise<MemoryRunLedger> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: dir })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const domain = await ctx.storageDomain.open(memoryRunDomain)
  return new MemoryRunLedger(domain)
}

const draft = (slug: string, over: Partial<EntryDraft> = {}): EntryDraft => ({
  type: 'project',
  slug,
  title: `条目 ${slug}`,
  hook: `${slug} 的一句话钩子`,
  body: `正文 ${slug}。\n\nWhy: 测试。\nHow to apply: 忽略。`,
  source: 'session',
  ...over,
})

/** 合成一个 ReadEntry，供纯函数计划断言（不碰磁盘）。 */
function synthetic(over: Partial<ReadEntry> & { relativePath: string }): ReadEntry {
  const type = (over.type ?? over.relativePath.split('/')[0]) as ReadEntry['type']
  const title = over.title ?? over.relativePath
  const hook = over.hook ?? '钩子'
  return {
    relativePath: over.relativePath,
    type,
    title,
    hook,
    body: over.body ?? '正文',
    bodySha256: over.bodySha256 ?? 'x'.repeat(64),
    createdAt: over.createdAt ?? '',
    handEdited: over.handEdited ?? false,
    indexLine: over.indexLine ?? indexLineFor(title, over.relativePath, hook),
  }
}

describe('planDistill：分值排序与守卫（纯函数）', () => {
  it('未超预算时全部留下，按分值降序（近且权重高在前）', () => {
    const now = CLOCK
    const fresh = synthetic({ relativePath: 'project/fresh.md', createdAt: new Date(now).toISOString() })
    const staleRef = synthetic({ relativePath: 'reference/old.md', createdAt: new Date(now - 90 * DAY_MS).toISOString() })
    const plan = planDistill([staleRef, fresh], { budget: { maxLines: 10, maxBytes: 4096 }, now })
    expect(plan.evictions).toHaveLength(0)
    expect(plan.guardedSkips).toBe(0)
    // user/feedback 权重高、project 高于 reference；且近的加分 ⇒ fresh(project) 排在 old(reference) 前。
    expect(plan.kept.map(e => e.relativePath)).toEqual(['project/fresh.md', 'reference/old.md'])
  })

  it('ME2：超线的手改条目不淘汰，计入 guardedSkips；非手改的才进淘汰候选', () => {
    const entries = [
      synthetic({ relativePath: 'user/a.md' }),
      synthetic({ relativePath: 'user/b.md' }),
      synthetic({ relativePath: 'project/c.md', handEdited: true }),
      synthetic({ relativePath: 'reference/d.md' }),
    ]
    const plan = planDistill(entries, { budget: { maxLines: 2, maxBytes: 4096 }, now: CLOCK })
    // 前两名（user 权重最高）留下占预算；剩下的里 handEdited 的 project/c 被保护留下，reference/d 被淘汰。
    expect(plan.guardedSkips).toBe(1)
    expect(plan.evictions.map(e => e.relativePath)).toEqual(['reference/d.md'])
    expect(plan.kept.map(e => e.relativePath)).toContain('project/c.md')
  })

  it('无出生时间的条目按 0 天处理（不罚旧，宁可保守留任）', () => {
    const undated = synthetic({ relativePath: 'reference/undated.md', createdAt: '' })
    const dated = synthetic({ relativePath: 'reference/dated.md', createdAt: new Date(CLOCK - 200 * DAY_MS).toISOString() })
    const plan = planDistill([dated, undated], { budget: { maxLines: 10, maxBytes: 4096 }, now: CLOCK })
    // 无日期 = 视作当天 ⇒ 分数高于 200 天前的同权重条目 ⇒ 排在前。
    expect(plan.kept[0]!.relativePath).toBe('reference/undated.md')
  })
})

describe('renderIndex：整段形状（ME10 单写者的产物）', () => {
  it('有幸存条目时标题行 + 每条目一行，且只含 kept 的行（不含被淘汰者 ⇒ 无悬空）', () => {
    const kept = [synthetic({ relativePath: 'project/one.md', title: '一', hook: 'h1' })]
    const text = renderIndex(kept)
    expect(text.startsWith('# 长期记忆索引\n')).toBe(true)
    expect(text).toContain('- [一](project/one.md) — h1')
    expect(text.trimEnd().split('\n').filter(line => line.startsWith('- [')).length).toBe(1)
  })

  it('零幸存条目 ⇒ 只写标题行（空索引 = 没有条目行，注入段据此判「没有记忆」）', () => {
    expect(renderIndex([])).toBe('# 长期记忆索引\n')
  })
})

describe('ageDaysOf', () => {
  it('合法 ISO ⇒ 精确天数；空串或坏串 ⇒ 0（不因为写歪的 createdAt 加权或罚旧）', () => {
    expect(ageDaysOf(new Date(CLOCK - 5 * DAY_MS).toISOString(), CLOCK)).toBeCloseTo(5, 6)
    expect(ageDaysOf('', CLOCK)).toBe(0)
    expect(ageDaysOf('not-a-date', CLOCK)).toBe(0)
  })
})

describe('distillOnce：水位线 + 归档 + 索引整段重建（真目录 + 真台账）', () => {
  it('首夜：没有水位线且有当天流水 ⇒ 重排索引、前移水位线、台账记 distilled', async () => {
    const { store, dir } = await newStoreDir()
    await store.writeEntry(draft('alpha'))
    await store.writeEntry(draft('beta', { type: 'user' }))
    const ledger = await bootLedger(dir)

    const run = await distillOnce({ store, ledger }, { now: () => CLOCK })

    expect(run.outcome).toBe('distilled')
    expect(run.watermarkFrom).toBe(null)
    expect(run.watermarkTo).toBe('2026-10-10')
    expect(run.indexLines).toBe(2)
    const index = await readFile(join(dir, 'memories', 'MEMORY.md'), 'utf8')
    expect(index).toContain('(user/beta.md)')
    expect(index).toContain('(project/alpha.md)')
    // user 权重高 ⇒ 排在前
    expect(index.indexOf('user/beta.md')).toBeLessThan(index.indexOf('project/alpha.md'))
    // 台账真的落了一行，可被读回
    expect(ledger.latest()?.runId).toBe(runIdOf(CLOCK))
  })

  it('DM8 幂等：紧接着再蒸一次没有新日级 ⇒ no-op，索引字节一个都不动', async () => {
    const { store, dir } = await newStoreDir()
    await store.writeEntry(draft('alpha'))
    const ledger = await bootLedger(dir)
    await distillOnce({ store, ledger }, { now: () => CLOCK })
    const indexPath = join(dir, 'memories', 'MEMORY.md')
    const before = await readFile(indexPath, 'utf8')

    const second = await distillOnce({ store, ledger }, { now: () => CLOCK + 1 })

    expect(second.outcome).toBe('no-op')
    expect(second.archived).toBe(0)
    expect(second.promoted).toBe(0)
    expect(await readFile(indexPath, 'utf8')).toBe(before)
  })

  it('ME3：删掉水位线后重蒸 ⇒ 不新增条目、索引行集不变（加法协议而非靠水位线存活）', async () => {
    const { store, dir } = await newStoreDir()
    await store.writeEntry(draft('alpha'))
    await store.writeEntry(draft('beta', { type: 'feedback' }))
    const ledger = await bootLedger(dir)
    await distillOnce({ store, ledger }, { now: () => CLOCK })
    const memDir = join(dir, 'memories')
    const firstIndex = await readFile(join(memDir, 'MEMORY.md'), 'utf8')

    // 模拟水位线丢失/坏文件：直接删掉，让蒸馏把它当「没有」。promote 钩子这里缺席（无模型），
    // 所以即便重扫当天流水也不产生新条目——加法协议的证据是「文件集不变」。
    await rm(join(memDir, 'daily', '.watermark'), { force: true })
    const rerun = await distillOnce({ store, ledger }, { now: () => CLOCK + DAY_MS })

    expect(rerun.outcome).toBe('distilled')
    // 磁盘上仍只有那两个条目文件，没有第三个（重蒸不重复落盘）
    await expect(readFile(join(memDir, 'project', 'alpha.md'), 'utf8')).resolves.toBeTruthy()
    const entries = await store.scanEntries()
    expect(entries.map(e => e.relativePath).sort()).toEqual(['feedback/beta.md', 'project/alpha.md'])
    // 索引内容（忽略标题后行序）与第一次一致：重建是磁盘现算的确定函数
    const lines = (s: string) => s.split('\n').filter(l => l.startsWith('- [')).sort()
    expect(lines(await readFile(join(memDir, 'MEMORY.md'), 'utf8'))).toEqual(lines(firstIndex))
  })

  it('淘汰：超预算的低分条目被归档，索引不留指向已归档文件的悬空行（ME10 无悬空）', async () => {
    const { store, dir } = await newStoreDir()
    // 四个 project（同权重、同 createdAt ⇒ 并列时按路径升序）；预算留 2 行 ⇒ 后两条被淘汰归档。
    for (const slug of ['a1', 'a2', 'b1', 'b2']) await store.writeEntry(draft(slug))
    const ledger = await bootLedger(dir)

    const run = await distillOnce({ store, ledger }, {
      now: () => CLOCK,
      budget: { maxLines: 2, maxBytes: 4096 },
    })

    expect(run.archived).toBe(2)
    expect(run.indexLines).toBe(2)
    const index = await readFile(join(dir, 'memories', 'MEMORY.md'), 'utf8')
    expect(index).toContain('(project/a2.md)')
    expect(index).not.toContain('project/b1.md')
    expect(index).not.toContain('project/b2.md')
    // 被淘汰的文件确实移走了（归档），不是还留在原址却从索引消失
    await expect(readFile(join(dir, 'memories', 'project', 'b2.md'), 'utf8')).rejects.toThrow()
  })

  it('ME2 端到端：超线但手改的条目不被归档，guardedSkips 计一次', async () => {
    const { store, dir } = await newStoreDir()
    await store.writeEntry(draft('a1'))
    await store.writeEntry(draft('a2'))
    await store.writeEntry(draft('h1'))
    // 手工把 h1 的正文改掉而不动它存的 bodySha256 ⇒ readEntry 判定为手改。
    const memDir = join(dir, 'memories')
    const tampered = join(memDir, 'project', 'h1.md')
    const original = await readFile(tampered, 'utf8')
    await writeFile(tampered, original.replace('正文 h1。', '正文 h1。 人手补的一句。'), 'utf8')
    const ledger = await bootLedger(dir)

    const run = await distillOnce({ store, ledger }, {
      now: () => CLOCK,
      budget: { maxLines: 2, maxBytes: 4096 },
    })

    // 三条同权重同时间 ⇒ 并列按路径升序：a1、a2 占预算，h1 越线。h1 手改 ⇒ 留下并计入 guardedSkips。
    expect(run.guardedSkips).toBe(1)
    expect(run.archived).toBe(0)
    await expect(readFile(tampered, 'utf8')).resolves.toContain('人手补的一句')
  })

  it('promote 钩子（模型侧提炼）被调用并计入 promoted，且只喂水位线之后的日级', async () => {
    const { store, dir } = await newStoreDir()
    await store.writeEntry(draft('alpha'))
    const ledger = await bootLedger(dir)
    const seen: string[][] = []
    const run = await distillOnce(
      { store, ledger },
      {
        now: () => CLOCK,
        promote: async input => {
          seen.push([...input.newDays])
          return { promoted: 3 }
        },
      },
    )
    expect(run.promoted).toBe(3)
    expect(seen).toEqual([['2026-10-10']])
  })
})

describe('office_memory_run 台账', () => {
  it('runIdOf 由 startedAt 派生且稳定（at-least-once 重投收敛到同一行）', () => {
    expect(runIdOf(CLOCK)).toBe(runIdOf(CLOCK))
    expect(runIdOf(CLOCK)).toContain('run-')
    // 主键不含冒号（per-record 主键约束）
    expect(runIdOf(CLOCK)).not.toContain(':')
  })

  it('record 覆盖写同 runId、latest 按 startedAt 取最新', async () => {
    const { dir } = await newStoreDir()
    const ledger = await bootLedger(dir)
    await ledger.record({
      runId: runIdOf(1000), startedAt: 1000, finishedAt: 1001, outcome: 'no-op',
      promoted: 0, archived: 0, indexLines: 1, guardedSkips: 0, watermarkFrom: 'x', watermarkTo: 'x',
    })
    await ledger.record({
      runId: runIdOf(2000), startedAt: 2000, finishedAt: 2001, outcome: 'distilled',
      promoted: 0, archived: 0, indexLines: 2, guardedSkips: 0, watermarkFrom: 'x', watermarkTo: 'y',
    })
    expect(ledger.all()).toHaveLength(2)
    expect(ledger.latest()?.startedAt).toBe(2000)
    // 同 startedAt 再记一次 = 覆盖，不增行
    await ledger.record({
      runId: runIdOf(2000), startedAt: 2000, finishedAt: 2002, outcome: 'no-op',
      promoted: 0, archived: 0, indexLines: 2, guardedSkips: 0, watermarkFrom: 'y', watermarkTo: 'y',
    })
    expect(ledger.all()).toHaveLength(2)
    expect(ledger.run(runIdOf(2000))?.outcome).toBe('no-op')
  })
})
