import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, name, type OfficeAuthz } from './index.ts'

/** 最小假 ctx：只提供 `reflect.provide` 与 `effect`。 */
function fakeCtx(): { ctx: Context; provided: Map<string, unknown>; disposer: () => (() => void) | void | undefined } {
  const provided = new Map<string, unknown>()
  let disposer: (() => void) | void | undefined
  const ctx = {
    reflect: {
      provide: (key: string, value: unknown) => {
        provided.set(key, value)
        return () => { provided.delete(key) }
      },
    },
    effect: (setup: () => (() => void) | void) => { disposer = setup(); return disposer },
  }
  return { ctx: ctx as unknown as Context, provided, disposer: () => disposer }
}

describe('office-authz 插件壳', () => {
  it('name 正确', () => {
    expect(name).toBe('office-authz')
  })

  it('apply 提供只读授权服务，卸载后撤掉', () => {
    const fake = fakeCtx()
    apply(fake.ctx)
    const svc = fake.provided.get('officeAuthz') as OfficeAuthz
    expect(svc).toBeDefined()
    expect(svc.can('owner', 'bundle.install')).toBe(true)
    expect(svc.can('guest', 'console.view')).toBe(false)
    expect(() => svc.assertCan('member', 'bundle.install')).toThrow()
    fake.disposer()?.()
    expect(fake.provided.has('officeAuthz')).toBe(false)
  })
})
