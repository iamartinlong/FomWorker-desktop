import { describe, expect, it } from 'vitest'
import { FLUSH_ROUTE, SYNC_ROUTE, apply } from './index.ts'

/** 假 ctx：`get` 给 connection；`on`/`effect` 记 disposer；`inject` 立即回调。 */
function makeCtx(events: string[], routes: string[], disposers: (() => void)[]): Record<string, unknown> {
  const ctx: Record<string, unknown> = {
    get: (key: string) => (key === 'connection'
      ? {
          fetch: {
            register: (route: { path: string }) => {
              routes.push(route.path)
              return async () => {
                const i = routes.indexOf(route.path)
                if (i >= 0) routes.splice(i, 1)
              }
            },
          },
        }
      : undefined),
    on: (name: string) => {
      events.push(name)
      return () => {
        const i = events.indexOf(name)
        if (i >= 0) events.splice(i, 1)
      }
    },
    inject: (_services: string[], callback: (child: unknown) => void) => callback(ctx),
    effect: (setup: () => (() => void) | void) => {
      const dispose = setup()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    reflect: { provide: () => {} },
  }
  return ctx
}

describe('office-reporter · 挂载（事件驱动触发 + 路由接线）', () => {
  it('http 模式：监听 session/event + 注册 flush/sync 路由；卸载撤掉', () => {
    const events: string[] = []
    const routes: string[] = []
    const disposers: (() => void)[] = []
    const ctx = makeCtx(events, routes, disposers)

    apply(ctx as never, { transport: 'http', platformUrl: 'http://p' })

    expect(events).toContain('session/event')
    expect(routes).toEqual(expect.arrayContaining([FLUSH_ROUTE, SYNC_ROUTE]))

    for (const dispose of disposers) dispose()
    expect(events).not.toContain('session/event')
    expect(routes).toEqual([])
  })

  it('memory 模式：不注册路由、不监听事件（纯 mock）', () => {
    const events: string[] = []
    const routes: string[] = []
    const ctx = makeCtx(events, routes, [])
    apply(ctx as never, { transport: 'memory' })
    expect(events).toEqual([])
    expect(routes).toEqual([])
  })
})
