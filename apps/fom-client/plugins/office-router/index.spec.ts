import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, name, type OfficeRouter } from './index.ts'

function fakeCtx(): { ctx: Context; provided: Map<string, unknown>; disposer: () => (() => void) | void | undefined } {
  const provided = new Map<string, unknown>()
  let disposer: (() => void) | void | undefined
  const ctx = {
    reflect: { provide: (key: string, value: unknown) => { provided.set(key, value); return () => { provided.delete(key) } } },
    effect: (setup: () => (() => void) | void) => { disposer = setup(); return disposer },
  }
  return { ctx: ctx as unknown as Context, provided, disposer: () => disposer }
}

describe('office-router 插件壳', () => {
  it('name 正确', () => expect(name).toBe('office-router'))

  it('apply 提供 officeRouter 服务，卸载后撤掉', () => {
    const fake = fakeCtx()
    apply(fake.ctx)
    const svc = fake.provided.get('officeRouter') as OfficeRouter
    expect(svc).toBeDefined()
    expect(svc.roles).toEqual(['owner', 'admin', 'member', 'guest'])
    fake.disposer()?.()
    expect(fake.provided.has('officeRouter')).toBe(false)
  })
})
