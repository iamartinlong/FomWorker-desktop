import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ACTIONS_ROUTE } from './actions-route.ts'
import { WRITE_ROUTE } from './console-actions.ts'
import { STATE_ROUTE } from './state-route.ts'
import { CATALOG_ROUTE, apply, createCatalogHandler, inject, name } from './index.ts'
import { createCatalogService } from '../office-catalog/catalog.ts'
import { createAuthzService } from '../office-authz/index.ts'

function fakeRes(): { response: ServerResponse; out: { status?: number; body?: string } } {
  const out: { status?: number; body?: string } = {}
  const response = {
    writeHead: (status: number) => { out.status = status; return response },
    end: (body?: string) => { out.body = body },
  }
  return { response: response as unknown as ServerResponse, out }
}

/** 假 ctx：`get` 按表；`inject` 立即回调；`effect` 执行并把 disposer 收进数组。 */
function makeCtx(services: Record<string, unknown>): { ctx: Context; disposers: (() => void)[] } {
  const disposers: (() => void)[] = []
  const ctx: Record<string, unknown> = {
    get: (key: string) => services[key],
    effect: (setup: () => (() => void) | void) => {
      const dispose = setup()
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
      return dispose
    },
  }
  ctx.inject = (_services: string[], callback: (scope: unknown) => void) => callback(ctx)
  return { ctx: ctx as unknown as Context, disposers }
}

const webServer = (routes: string[]): unknown => ({
  register: (route: { path: string }) => {
    routes.push(route.path)
    return () => { const i = routes.indexOf(route.path); if (i >= 0) routes.splice(i, 1) }
  },
})

const connection = (writes: string[]): unknown => ({
  fetch: {
    register: (route: { path: string }) => {
      writes.push(route.path)
      return () => { const i = writes.indexOf(route.path); if (i >= 0) writes.splice(i, 1); return Promise.resolve() }
    },
  },
})

describe('office-console host · 只读目录路由', () => {
  const catalog = createCatalogService()
  const handler = createCatalogHandler(catalog)

  it('GET 返回目录 JSON', () => {
    const { response, out } = fakeRes()
    handler({ method: 'GET' } as IncomingMessage, response)
    expect(out.status).toBe(200)
    expect(JSON.parse(out.body ?? '{}').entries.some((e: { id: string }) => e.id === 'skill:meeting-minutes')).toBe(true)
  })

  it('非 GET 一律 405', () => {
    const { response, out } = fakeRes()
    handler({ method: 'POST' } as IncomingMessage, response)
    expect(out.status).toBe(405)
  })
})

describe('office-console host · 接线', () => {
  it('常量：name / inject（两依赖）', () => {
    expect(name).toBe('office-console')
    expect(inject).toEqual(['officeCatalog', 'officeAuthz'])
  })

  it('apply 挂两条只读路由 + 一条认证写路由，卸载撤掉', async () => {
    const readRoutes: string[] = []
    const writeRoutes: string[] = []
    const { ctx, disposers } = makeCtx({
      officeCatalog: createCatalogService(),
      officeAuthz: createAuthzService(),
      webServer: webServer(readRoutes),
      connection: connection(writeRoutes),
    })
    apply(ctx, { operatorRole: 'owner' })
    expect(readRoutes).toContain(CATALOG_ROUTE)
    expect(readRoutes).toContain(ACTIONS_ROUTE)
    expect(readRoutes).toContain(STATE_ROUTE)
    expect(writeRoutes).toContain(WRITE_ROUTE)
    for (const dispose of disposers) dispose()
    await Promise.resolve()
    await Promise.resolve()
    expect(readRoutes).toEqual([])
    expect(writeRoutes).toEqual([])
  })

  it('webServer/connection 不在（CLI 形态）时不抛', () => {
    const { ctx } = makeCtx({ officeCatalog: createCatalogService(), officeAuthz: createAuthzService() })
    expect(() => apply(ctx, { operatorRole: 'owner' })).not.toThrow()
  })

  it('officeCatalog 缺失时响亮抛', () => {
    const { ctx } = makeCtx({ officeAuthz: createAuthzService() })
    expect(() => apply(ctx, { operatorRole: 'owner' })).toThrow(/officeCatalog/)
  })

  it('officeAuthz 缺失时响亮抛', () => {
    const { ctx } = makeCtx({ officeCatalog: createCatalogService() })
    expect(() => apply(ctx, { operatorRole: 'owner' })).toThrow(/officeAuthz/)
  })

  it('operatorRole 非法时响亮抛', () => {
    const { ctx } = makeCtx({ officeCatalog: createCatalogService(), officeAuthz: createAuthzService() })
    expect(() => apply(ctx, { operatorRole: 'superuser' })).toThrow(/operatorRole/)
  })
})
