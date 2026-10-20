import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ACTIONS_ROUTE, createActionsHandler, parseRole } from './actions-route.ts'
import { createAuthzService } from '../office-authz/index.ts'

function fakeRes(): { response: ServerResponse; out: { status?: number; body?: string } } {
  const out: { status?: number; body?: string } = {}
  const response = {
    writeHead: (status: number) => { out.status = status; return response },
    end: (body?: string) => { out.body = body },
  }
  return { response: response as unknown as ServerResponse, out }
}

const handler = createActionsHandler(createAuthzService())

describe('office-console · 动作决策路由', () => {
  it('route 常量', () => expect(ACTIONS_ROUTE).toBe('/office/console/actions'))

  it('GET ?role=member 返回该角色的动作决策', () => {
    const { response, out } = fakeRes()
    handler({ method: 'GET', url: '/office/console/actions?role=member' } as IncomingMessage, response)
    expect(out.status).toBe(200)
    const body = JSON.parse(out.body ?? '{}') as { role: string; decisions: { action: string; allowed: boolean; requiresApproval: boolean }[] }
    expect(body.role).toBe('member')
    const byAction = Object.fromEntries(body.decisions.map((d) => [d.action, d]))
    expect(byAction['bundle.install'].allowed).toBe(false)
    expect(byAction['bundle.install'].requiresApproval).toBe(true)
    expect(byAction['skill.create'].allowed).toBe(true)
    expect(byAction['console.view'].allowed).toBe(true)
  })

  it('owner 可安装且标高危', () => {
    const { response, out } = fakeRes()
    handler({ method: 'GET', url: '/office/console/actions?role=owner' } as IncomingMessage, response)
    const body = JSON.parse(out.body ?? '{}') as { decisions: { action: string; allowed: boolean; requiresApproval: boolean }[] }
    const install = body.decisions.find((d) => d.action === 'bundle.install')
    expect(install?.allowed).toBe(true)
    expect(install?.requiresApproval).toBe(true)
  })

  it('缺 role → 400（不猜）', () => {
    const { response, out } = fakeRes()
    handler({ method: 'GET', url: '/office/console/actions' } as IncomingMessage, response)
    expect(out.status).toBe(400)
  })

  it('非法 role → 400', () => {
    const { response, out } = fakeRes()
    handler({ method: 'GET', url: '/office/console/actions?role=superuser' } as IncomingMessage, response)
    expect(out.status).toBe(400)
  })

  it('非 GET → 405', () => {
    const { response, out } = fakeRes()
    handler({ method: 'POST', url: '/office/console/actions?role=owner' } as IncomingMessage, response)
    expect(out.status).toBe(405)
  })

  it('parseRole 解析已知/未知', () => {
    expect(parseRole('/x?role=admin')).toBe('admin')
    expect(parseRole('/x?role=nope')).toBeUndefined()
    expect(parseRole(undefined)).toBeUndefined()
  })
})
