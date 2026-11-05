import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { HEALTH_ROUTE, createHealthHandler } from './health-route.ts'

function fakeRes(): { response: ServerResponse; out: { status?: number; body?: string } } {
  const out: { status?: number; body?: string } = {}
  const response = {
    writeHead: (status: number) => { out.status = status; return response },
    end: (body?: string) => { out.body = body },
  }
  return { response: response as unknown as ServerResponse, out }
}

describe('office-observe · 健康端点', () => {
  it('route 常量', () => expect(HEALTH_ROUTE).toBe('/health'))

  it('GET 正常 ⇒ 200 + 报告', () => {
    const handler = createHealthHandler(() => ({ status: 'ok', checks: { meter: true, audit: true } }))
    const { response, out } = fakeRes()
    handler({ method: 'GET' } as IncomingMessage, response)
    expect(out.status).toBe(200)
    expect(JSON.parse(out.body ?? '{}')).toEqual({ status: 'ok', checks: { meter: true, audit: true } })
  })

  it('GET degraded ⇒ 503', () => {
    const handler = createHealthHandler(() => ({ status: 'degraded', checks: { meter: true, audit: false } }))
    const { response, out } = fakeRes()
    handler({ method: 'GET' } as IncomingMessage, response)
    expect(out.status).toBe(503)
  })

  it('非 GET ⇒ 405', () => {
    const handler = createHealthHandler(() => ({ status: 'ok', checks: {} }))
    const { response, out } = fakeRes()
    handler({ method: 'POST' } as IncomingMessage, response)
    expect(out.status).toBe(405)
  })
})
