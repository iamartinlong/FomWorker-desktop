/**
 * `ItemStore` 的域级验收：**真 JSON 后端**（不是内存 Map）——这里要验的正是
 * 「写入在 resolve 前已持久、重启仍在、上限会拒」，假存储两样都测不到。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { ItemStore, assistantItemsDomain } from './items-domain.ts'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'office-items-'))
  roots.push(root)
  return root
}

/** 与产品 patch 相同的存储栈：hub + json 后端 + domain 形式。 */
async function boot(root: string, options: { maxItems?: number } = {}): Promise<{ ctx: Context; store: ItemStore }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const domain = await ctx.storageDomain.open(assistantItemsDomain)
  return { ctx, store: new ItemStore(domain, options) }
}

const NOW = 1_790_000_000_000

describe('ItemStore（真 JSON 后端）', () => {
  it('增/勾/改/删 都能落盘，list 按 D-6 排序', async () => {
    const root = await newRoot()
    const { store } = await boot(root)

    const a = await store.add('买咖啡', NOW)
    const b = await store.add('交周报', NOW, { dueAt: NOW + 1_000 })
    expect(store.list().map((row) => row.text)).toEqual(['交周报', '买咖啡'])

    const done = await store.toggle(a.id, NOW + 10)
    expect(done?.status).toBe('done')
    expect(store.list().map((row) => row.text)).toEqual(['交周报', '买咖啡'])

    await store.edit(b.id, '  交周报（改）  ', NOW + 20)
    expect(store.get(b.id)?.text).toBe('交周报（改）')

    expect(await store.remove(b.id)).toBe(true)
    expect(store.get(b.id)).toBeUndefined()
    expect(store.list()).toHaveLength(1)
  })

  it('重启（重新打开域）后事项还在', async () => {
    const root = await newRoot()
    const first = await boot(root)
    const created = await first.store.add('重启也要在', NOW)
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const second = await boot(root)
    expect(second.store.get(created.id)).toMatchObject({ text: '重启也要在', status: 'open' })
  })

  it('prune 只清已完成且超 90 天的', async () => {
    const root = await newRoot()
    const { store } = await boot(root)
    const old = await store.add('很久前完成', NOW - 100 * 24 * 60 * 60 * 1_000)
    await store.toggle(old.id, NOW - 100 * 24 * 60 * 60 * 1_000)
    const fresh = await store.add('刚完成', NOW - 1_000)
    await store.toggle(fresh.id, NOW - 1_000)
    const open = await store.add('还没做', NOW - 200 * 24 * 60 * 60 * 1_000)

    expect(await store.prune(NOW)).toBe(1)
    expect(store.get(old.id)).toBeUndefined()
    expect(store.get(fresh.id)).toBeDefined()
    expect(store.get(open.id)).toBeDefined()
  })

  it('达上限后 add 拒，并给一句人话（上限可注入，单测用小值）', async () => {
    const root = await newRoot()
    const { store } = await boot(root, { maxItems: 2 })
    await store.add('第一条', NOW)
    await store.add('第二条', NOW)

    await expect(store.add('再来一条', NOW)).rejects.toThrow('上限（2 条）')
    expect(store.list()).toHaveLength(2)
  })

  it('改不存在的 id ⇒ undefined（不造新行）', async () => {
    const root = await newRoot()
    const { store } = await boot(root)
    expect(await store.toggle('nope', NOW)).toBeUndefined()
    expect(await store.edit('nope', 'x', NOW)).toBeUndefined()
    expect(store.list()).toEqual([])
  })

  it('日终简报：落盘、按日期覆盖、重启仍在', async () => {
    const root = await newRoot()
    const first = await boot(root)
    const digest = {
      id: '2026-10-19',
      date: '2026-10-19',
      createdAt: NOW,
      openCount: 2,
      doneToday: 1,
      overdueCount: 1,
      lines: ['还有 2 条没做完', '· 交周报'],
      text: '还有 2 条没做完\n· 交周报',
    }

    await first.store.saveDigest(digest)
    expect(first.store.latestDigest()).toMatchObject({ id: '2026-10-19', openCount: 2 })
    expect(first.store.digestOf('2026-10-19')?.text).toContain('交周报')

    // 同一天再存一次 ⇒ 覆盖（不堆两条）。
    await first.store.saveDigest({ ...digest, openCount: 0, lines: ['待办已清空'] })
    expect(first.store.latestDigest()).toMatchObject({ id: '2026-10-19', openCount: 0 })

    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const second = await boot(root)
    expect(second.store.latestDigest()?.lines).toEqual(['待办已清空'])
  })

  it('简报超 90 天会被清理', async () => {
    const root = await newRoot()
    const { store } = await boot(root)
    const old = NOW - 100 * 24 * 60 * 60 * 1_000
    await store.saveDigest({
      id: '2026-07-01', date: '2026-07-01', createdAt: old,
      openCount: 1, doneToday: 0, overdueCount: 0, lines: ['旧'], text: '旧',
    })
    await store.saveDigest({
      id: '2026-10-19', date: '2026-10-19', createdAt: NOW,
      openCount: 1, doneToday: 0, overdueCount: 0, lines: ['新'], text: '新',
    })

    expect(await store.pruneDigests(NOW)).toBe(1)
    expect(store.digestOf('2026-07-01')).toBeUndefined()
    expect(store.digestOf('2026-10-19')).toBeDefined()
  })
})
