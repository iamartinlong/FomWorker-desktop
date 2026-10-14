import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, name } from './index.ts'
import type { OfficeCatalog } from './catalog.ts'

/** 最小假 ctx：只提供 `reflect.provide` 与 `effect`，够验壳的接线与释放。 */
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
    effect: (setup: () => (() => void) | void) => {
      disposer = setup()
      return disposer
    },
  }
  return { ctx: ctx as unknown as Context, provided, disposer: () => disposer }
}

describe('office-catalog 插件壳', () => {
  it('name 正确', () => {
    expect(name).toBe('office-catalog')
  })

  it('apply 在 officeCatalog 名下提供只读服务，卸载后撤掉', () => {
    const fake = fakeCtx()
    apply(fake.ctx)
    const svc = fake.provided.get('officeCatalog') as OfficeCatalog
    expect(svc).toBeDefined()
    expect(svc.validate()).toEqual([])
    expect(svc.list().length).toBeGreaterThan(0)
    fake.disposer()?.()
    expect(fake.provided.has('officeCatalog')).toBe(false)
  })
})
