import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { STATE_ROUTE, createStateHandler } from './state-route.ts'
import { createCapabilityStore } from './executor.ts'

function fakeRes(): { response: ServerResponse; out: { status?: number; body?: string } } {
  const out: { status?: number; body?: string } = {}
  const response = {
    writeHead: (status: number) => { out.status = status; return response },
    end: (body?: string) => { out.body = body },
  }
  return { response: response as unknown as ServerResponse, out }
}

describe('office-console · 状态读路由', () => {
  it('route 常量', () => expect(STATE_ROUTE).toBe('/office/console/state'))

  it('GET 返回操作者角色 + 能力启用态', () => {
    const store = createCapabilityStore([{ id: 'skill:a', enabled: true }, { id: 'connector:b', enabled: false }])
    const handler = createStateHandler(store, 'owner')
    const { response, out } = fakeRes()
    handler({ method: 'GET' } as IncomingMessage, response)
    expect(out.status).toBe(200)
    const body = JSON.parse(out.body ?? '{}') as { operatorRole: string; capabilities: { id: string; enabled: boolean }[] }
    expect(body.operatorRole).toBe('owner')
    expect(body.capabilities).toEqual([{ id: 'skill:a', enabled: true }, { id: 'connector:b', enabled: false }])
  })

  it('非 GET ⇒ 405', () => {
    const handler = createStateHandler(createCapabilityStore([]), 'owner')
    const { response, out } = fakeRes()
    handler({ method: 'POST' } as IncomingMessage, response)
    expect(out.status).toBe(405)
  })
})
