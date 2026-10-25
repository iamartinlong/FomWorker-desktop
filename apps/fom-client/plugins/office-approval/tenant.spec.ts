import { describe, expect, it } from 'vitest'
import { createTenantResolver } from './tenant.ts'

describe('createTenantResolver', () => {
  it('固定租户（配置写了 tenantId）⇒ 恒用它，不读凭据（M1 / 单租户形态）', async () => {
    let reads = 0
    const resolver = createTenantResolver({
      fixed: 'tenant-local',
      readToken: async () => { reads += 1; return 'tok' },
      parseTenant: () => 'from-jwt',
    })
    expect(resolver.current()).toEqual({ tenantId: 'tenant-local' })
    await resolver.refresh()
    expect(resolver.current()).toEqual({ tenantId: 'tenant-local' })
    expect(reads).toBe(0)
  })

  it('派生：refresh 后 current 给 JWT 里的租户（起手那次 await 是 `apply` 用的）', async () => {
    const resolver = createTenantResolver({
      readToken: async () => 'tok',
      parseTenant: token => token === 'tok' ? 'tenant-from-jwt' : undefined,
    })
    await resolver.refresh()
    expect(resolver.current()).toEqual({ tenantId: 'tenant-from-jwt' })
  })

  it('没登录（令牌空）⇒ undefined（闸交棒，不拿假租户记账）', async () => {
    const resolver = createTenantResolver({ readToken: async () => '', parseTenant: () => 'nope' })
    await resolver.refresh()
    expect(resolver.current()).toBeUndefined()
  })

  it('令牌解不出租户 ⇒ undefined', async () => {
    const resolver = createTenantResolver({ readToken: async () => 'broken', parseTenant: () => undefined })
    await resolver.refresh()
    expect(resolver.current()).toBeUndefined()
  })

  it('登出（令牌由有变空）⇒ 立刻清空旧租户', async () => {
    let token = 'tok'
    const resolver = createTenantResolver({ readToken: async () => token, parseTenant: () => 't1' })
    await resolver.refresh()
    expect(resolver.current()).toEqual({ tenantId: 't1' })
    token = ''
    await resolver.refresh()
    expect(resolver.current()).toBeUndefined()
  })

  it('过期后 `current()` 顺手后台刷一次（TTL）；起手那次也走这条路', async () => {
    let now = 1_000
    let token = 'a'
    let reads = 0
    const resolver = createTenantResolver({
      readToken: async () => { reads += 1; return token },
      parseTenant: t => t === 'a' ? 'ta' : 'tb',
      now: () => now,
      ttlMs: 10_000,
    })
    // 起手：缓存空 ⇒ 交棒（undefined），但后台已开刷。
    expect(resolver.current()).toBeUndefined()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(resolver.current()).toEqual({ tenantId: 'ta' })
    const readsAfterFirst = reads
    // 未过期：不再读。
    now += 5_000
    expect(resolver.current()).toEqual({ tenantId: 'ta' })
    expect(reads).toBe(readsAfterFirst)
    // 过期 + 换了令牌 ⇒ 后台刷到新租户。
    now += 20_000
    token = 'b'
    expect(resolver.current()).toEqual({ tenantId: 'ta' })   // 本次仍答旧缓存
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(resolver.current()).toEqual({ tenantId: 'tb' })
  })

  it('读凭据出错 ⇒ 保留旧值 + 上报（瞬时故障不打回未登录）', async () => {
    let fail = false
    const errors: unknown[] = []
    const resolver = createTenantResolver({
      readToken: async () => { if (fail) throw new Error('disk'); return 'tok' },
      parseTenant: () => 't1',
      onError: error => { errors.push(error) },
    })
    await resolver.refresh()
    expect(resolver.current()).toEqual({ tenantId: 't1' })
    fail = true
    await resolver.refresh()
    expect(resolver.current()).toEqual({ tenantId: 't1' })
    expect(errors).toHaveLength(1)
  })
})
