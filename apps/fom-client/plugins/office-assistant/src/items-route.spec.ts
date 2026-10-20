/**
 * 路由层验收：`action=digest` 的读/出两份行为，与 `GET /api/office/items` 一起回简报。
 */
import { describe, expect, it, vi } from 'vitest'
import { createItemsFetch } from './index.ts'
import type { AssistantDigest } from './digest.ts'
import type { AssistantItem } from './items.ts'

const NOW = new Date(2026, 9, 19, 18, 30, 0, 0).getTime()

const DIGEST: AssistantDigest = {
  id: '2026-10-19',
  date: '2026-10-19',
  createdAt: NOW,
  openCount: 1,
  doneToday: 1,
  overdueCount: 0,
  lines: ['今天完成 1 条：交周报', '还有 1 条没做完', '· 看书'],
  text: '今天完成 1 条：交周报\n还有 1 条没做完\n· 看书',
}

const ITEM: AssistantItem = {
  id: 'i-1',
  text: '看书',
  status: 'open',
  createdAt: NOW,
  updatedAt: NOW,
  source: 'panel',
}

/** 最小 store 替身（只实现路由用到的方法）。 */
function fakeStore(options: { items?: AssistantItem[]; digest?: AssistantDigest } = {}): {
  list(): AssistantItem[]
  latestDigest(): AssistantDigest | undefined
  add: ReturnType<typeof vi.fn>
  toggle: ReturnType<typeof vi.fn>
  edit: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
} {
  let latest = options.digest
  return {
    list: () => options.items ?? [ITEM],
    latestDigest: () => latest,
    add: vi.fn(async (text: string) => {
      latest = latest
      return { ...ITEM, text }
    }),
    toggle: vi.fn(async () => ITEM),
    edit: vi.fn(async () => ITEM),
    remove: vi.fn(async () => true),
  }
}

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
}

describe('createItemsFetch（简报）', () => {
  it('GET 事项时一并带最新简报', async () => {
    const fetchItems = createItemsFetch(
      fakeStore({ digest: DIGEST }) as never,
      () => NOW,
    )
    const payload = await (await fetchItems(req('GET', '/api/office/items'))).json()
    expect(payload).toMatchObject({ ok: true, digest: { id: '2026-10-19' } })
    expect(payload.items).toHaveLength(1)
  })

  it('还没有简报 ⇒ digest 为 null（不是 undefined，前端好判）', async () => {
    const fetchItems = createItemsFetch(fakeStore() as never, () => NOW)
    const payload = await (await fetchItems(req('GET', '/api/office/items'))).json()
    expect(payload.digest).toBeNull()
  })

  it('GET ?action=digest ⇒ 只回简报', async () => {
    const fetchItems = createItemsFetch(fakeStore({ digest: DIGEST }) as never, () => NOW)
    const payload = await (await fetchItems(req('GET', '/api/office/items?action=digest'))).json()
    expect(payload).toEqual({ ok: true, digest: DIGEST })
  })

  it('POST ?action=digest ⇒ 现出一份', async () => {
    const generate = vi.fn(async () => DIGEST)
    const fetchItems = createItemsFetch(fakeStore() as never, () => NOW, undefined, generate)
    const payload = await (await fetchItems(req('POST', '/api/office/items?action=digest'))).json()
    expect(generate).toHaveBeenCalledOnce()
    expect(payload).toMatchObject({ ok: true, digest: { id: '2026-10-19' } })
  })

  it('POST ?action=digest 空集 ⇒ ok + 一句人话（不报错）', async () => {
    const fetchItems = createItemsFetch(
      fakeStore() as never,
      () => NOW,
      undefined,
      async () => undefined,
    )
    const payload = await (await fetchItems(req('POST', '/api/office/items?action=digest'))).json()
    expect(payload).toMatchObject({ ok: true, digest: null, message: '今天没有可收拢的事' })
  })
})
