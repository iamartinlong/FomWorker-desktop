import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, createBillingService, createQuotaService, name, QUOTA_READ_ROUTE, QUOTA_SYNC_ROUTE, type OfficeBilling, type OfficeBillingConfig } from './index.ts'
import type { PriceTable } from './pricing.ts'

interface FakeRoute {
  path: string
  methods: readonly string[]
  fetch: (request: Request) => Promise<Response>
}

function fakeCtx(options: { token?: string; withConnection?: boolean } = {}): {
  ctx: Context
  provided: Map<string, unknown>
  registered: FakeRoute[]
  disposeAll: () => void
} {
  const provided = new Map<string, unknown>()
  const registered: FakeRoute[] = []
  const disposers: (() => void)[] = []
  const connection = { fetch: { register: (route: FakeRoute) => { registered.push(route); return async () => {} } } }
  const ctx = {
    reflect: { provide: (key: string, value: unknown) => { provided.set(key, value); return () => { provided.delete(key) } } },
    effect: (setup: () => (() => void) | void) => { const disposer = setup(); if (typeof disposer === 'function') disposers.push(disposer); return disposer },
    get: (key: string) => {
      if (key === 'connection') return options.withConnection === false ? undefined : connection
      if (key === 'credentials') return { resolve: async () => options.token === undefined ? undefined : { value: options.token } }
      return provided.get(key)
    },
    inject: (_deps: readonly string[], cb: (scoped: unknown) => void) => { cb(ctx) },
  }
  return { ctx: ctx as unknown as Context, provided, registered, disposeAll: () => { for (const disposer of disposers.splice(0)) disposer() } }
}

const config: OfficeBillingConfig = {
  currency: 'USD',
  prices: { m1: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 } },
  overageAction: 'reject',
  platformUrl: 'http://platform.test',
}

const quotaDto = { period: '2026-10', maxTokens: 100, maxCost: 0, maxCalls: 0, usedTokens: 120, usedCost: 0, usedCalls: 0 }

/** 200 的假 fetch，记下请求（断言 URL / 头）。 */
function okFetch(seen: { url?: string; headers?: Record<string, string> } = {}): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    seen.url = String(url)
    seen.headers = (init?.headers ?? {}) as Record<string, string>
    return new Response(JSON.stringify(quotaDto), { status: 200 })
  }) as unknown as typeof fetch
}

describe('office-billing 插件壳', () => {
  it('name 正确', () => expect(name).toBe('office-billing'))

  it('apply 提供 officeBilling 服务，卸载后撤掉', () => {
    const fake = fakeCtx()
    apply(fake.ctx, config)
    const svc = fake.provided.get('officeBilling') as OfficeBilling
    expect(svc).toBeDefined()
    expect(svc.cost('m1', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(18)
    fake.disposeAll()
    expect(fake.provided.has('officeBilling')).toBe(false)
  })

  it('apply 非法 overageAction ⇒ 响亮抛', () => {
    expect(() => apply(fakeCtx().ctx, { ...config, overageAction: 'block' })).toThrow(/overageAction/)
  })

  it('createBillingService：cost / total（未定价不静默按 0）/ quota', () => {
    const table: PriceTable = { currency: 'USD', models: config.prices }
    const svc = createBillingService(table, 'warn')
    expect(svc.cost('m1', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(3)
    expect(svc.cost('nope', { inputTokens: 1, outputTokens: 1 })).toBeUndefined()
    const breakdown = svc.total([
      { model: 'm1', usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } },
      { model: 'nope', usage: { inputTokens: 1, outputTokens: 0 } },
    ])
    expect(breakdown.amount).toBe(18)
    expect(breakdown.unpriced).toEqual(['nope'])
    expect(svc.quota({ tokens: 1, cost: 0, calls: 0 }, { maxTokens: 0 })).toMatchObject({ within: false, action: 'warn' })
  })

  it('未接平台 ⇒ 配额三方法：快照/预检 undefined，sync 响亮抛（不静默返回空）', async () => {
    const svc = createBillingService({ currency: 'USD', models: {} }, 'warn')
    expect(svc.quotaSnapshot()).toBeUndefined()
    expect(svc.precheckQuota()).toBeUndefined()
    await expect(svc.syncQuota()).rejects.toThrow(/未接平台/)
  })
})

describe('本地配额执行（K4）：createQuotaService', () => {
  it('没同步过 ⇒ precheck undefined（不编一个「未超限」）', () => {
    const quota = createQuotaService({ platformUrl: 'http://platform.test', token: () => 'tok' })
    expect(quota.snapshot()).toBeUndefined()
    expect(quota.precheck()).toBeUndefined()
  })

  it('sync 拉下来存快照（0 限额＝未设限）+ 带 Bearer + precheck 判超额', async () => {
    const seen: { url?: string; headers?: Record<string, string> } = {}
    const quota = createQuotaService({ platformUrl: 'http://platform.test/', token: () => 'tok', fetchImpl: okFetch(seen) })
    const snapshot = await quota.sync()
    expect(seen.url).toBe('http://platform.test/api/config/quota')
    expect(seen.headers?.authorization).toBe('Bearer tok')
    expect(snapshot.period).toBe('2026-10')
    expect(snapshot.limits).toEqual({ maxTokens: 100 })
    expect(quota.snapshot()).toEqual(snapshot)
    // used 120 > maxTokens 100 ⇒ 超限；动作来自配置（默认 warn）。
    expect(quota.precheck()).toEqual({ within: false, exceeded: ['tokens'], action: 'warn' })
  })

  it('sync 失败 ⇒ 不覆盖已有快照（旧值不被清掉，也不被冒充成新的）', async () => {
    let fail = false
    const fetchImpl = (async () => fail
      ? new Response('nope', { status: 500 })
      : new Response(JSON.stringify(quotaDto), { status: 200 })) as unknown as typeof fetch
    const quota = createQuotaService({ platformUrl: 'http://platform.test', token: () => 'tok', fetchImpl })
    const first = await quota.sync()
    fail = true
    await expect(quota.sync()).rejects.toThrow(/HTTP 500/)
    expect(quota.snapshot()).toEqual(first)
  })

  it('动作随配置（reject ⇒ verdict.action=reject）', async () => {
    const quota = createQuotaService({ platformUrl: 'http://platform.test', token: () => 'tok', action: 'reject', fetchImpl: okFetch() })
    await quota.sync()
    expect(quota.precheck()?.action).toBe('reject')
  })
})

describe('配额路由（认证 /api）', () => {
  it('挂两条：POST 同步 / GET 读；读路由在没同步过时回 snapshot/verdict 皆 null', async () => {
    const fake = fakeCtx({ token: 'tok' })
    apply(fake.ctx, config, { fetchImpl: okFetch() })
    expect(fake.registered.map(route => `${route.methods.join(',')} ${route.path}`)).toEqual([
      `POST ${QUOTA_SYNC_ROUTE}`,
      `GET ${QUOTA_READ_ROUTE}`,
    ])
    const read = fake.registered[1]!
    const before = await (await read.fetch(new Request('http://host/api/office/quota'))).json() as Record<string, unknown>
    expect(before).toEqual({ ok: true, snapshot: null, verdict: null })
  })

  it('同步路由拉成功 ⇒ 读路由随即给快照 + verdict（预检，不拦）', async () => {
    const fake = fakeCtx({ token: 'tok' })
    apply(fake.ctx, config, { fetchImpl: okFetch() })
    const sync = fake.registered[0]!
    const syncBody = await (await sync.fetch(new Request('http://host/api/office/quota/sync', { method: 'POST' }))).json() as Record<string, unknown>
    expect(syncBody.ok).toBe(true)
    expect(syncBody.period).toBe('2026-10')
    const read = fake.registered[1]!
    const body = await (await read.fetch(new Request('http://host/api/office/quota'))).json() as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.verdict).toEqual({ within: false, exceeded: ['tokens'], action: 'reject' })
  })

  it('同步失败 ⇒ ok:false + 原话（不把故障说成成功）', async () => {
    const fake = fakeCtx({ token: 'tok' })
    const failing = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
    apply(fake.ctx, config, { fetchImpl: failing })
    const body = await (await fake.registered[0]!.fetch(new Request('http://host/api/office/quota/sync', { method: 'POST' }))).json() as Record<string, unknown>
    expect(body.ok).toBe(false)
    expect(String(body.message)).toContain('401')
  })

  it('没有 connection 服务 ⇒ 不挂路由也不炸', () => {
    const fake = fakeCtx({ withConnection: false })
    expect(() => apply(fake.ctx, config)).not.toThrow()
    expect(fake.registered).toEqual([])
  })
})
