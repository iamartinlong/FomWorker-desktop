import { describe, expect, it, vi } from 'vitest'
import { WRITE_ROUTE, createEchoExecutor, createWriteFetch, parseWriteInput, type ConsoleActionExecutor } from './console-actions.ts'
import { OfficeInputError } from './executor.ts'
import { createApprovalStore } from './approvals.ts'
import { createAuthzService } from '../office-authz/index.ts'

const authz = createAuthzService()
const approvals = (): ReturnType<typeof createApprovalStore> => {
  let n = 0
  return createApprovalStore(() => `a${++n}`)
}

const post = (body: unknown): Request =>
  new Request('http://x/api/office/console/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('office-console · 写端点决策 (createWriteFetch，角色/审批均服务端)', () => {
  it('route 常量', () => expect(WRITE_ROUTE).toBe('/api/office/console/action'))

  it('operatorRole=owner + 非高危 ⇒ 200 done，执行', async () => {
    const execute = vi.fn(createEchoExecutor())
    const res = await createWriteFetch(authz, execute, 'owner', approvals())(post({ action: 'capability.toggle', payload: { id: 'x', on: true } }))
    expect(res.status).toBe(200)
    expect((await res.json() as { status: string }).status).toBe('done')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('operatorRole=member + 装插件 ⇒ 403（服务端角色），不执行', async () => {
    const execute = vi.fn(createEchoExecutor())
    const res = await createWriteFetch(authz, execute, 'member', approvals())(post({ action: 'bundle.install', payload: { spec: '@x/y' } }))
    expect(res.status).toBe(403)
    expect(execute).not.toHaveBeenCalled()
  })

  it('⚠️客户端伪造 role:owner 不被采信 ⇒ operatorRole=member 仍 403', async () => {
    const execute = vi.fn(createEchoExecutor())
    const res = await createWriteFetch(authz, execute, 'member', approvals())(post({ role: 'owner', action: 'bundle.install', payload: { spec: '@x/y' } }))
    expect(res.status).toBe(403)
    expect(execute).not.toHaveBeenCalled()
  })

  it('owner 装插件 ⇒ 202 needs-approval + 返回 approvalId', async () => {
    const execute = vi.fn(createEchoExecutor())
    const res = await createWriteFetch(authz, execute, 'owner', approvals())(post({ action: 'bundle.install', payload: { spec: '@x/y' } }))
    expect(res.status).toBe(202)
    const body = await res.json() as { status: string; approvalId: string }
    expect(body.status).toBe('needs-approval')
    expect(body.approvalId).toBe('a1')
    expect(execute).not.toHaveBeenCalled()
  })

  it('⭐服务端审批流：grant 后带 approvalId 重试 ⇒ 200 done（一次性）', async () => {
    const store = approvals()
    const execute = vi.fn(createEchoExecutor())
    const handler = createWriteFetch(authz, execute, 'owner', store)
    const first = await handler(post({ action: 'bundle.install', payload: { spec: '@x/y' } }))
    const { approvalId } = await first.json() as { approvalId: string }
    expect(store.grant(approvalId)?.status).toBe('granted')
    const second = await handler(post({ action: 'bundle.install', payload: { spec: '@x/y' }, approvalId }))
    expect(second.status).toBe(200)
    expect(execute).toHaveBeenCalledTimes(1)
    // 已消费：再带同一 id ⇒ 202（新 pending）
    const third = await handler(post({ action: 'bundle.install', payload: { spec: '@x/y' }, approvalId }))
    expect(third.status).toBe(202)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('⭐客户端带假 approvalId ⇒ 不采信 ⇒ 202', async () => {
    const execute = vi.fn(createEchoExecutor())
    const res = await createWriteFetch(authz, execute, 'owner', approvals())(post({ action: 'bundle.install', payload: { spec: '@x/y' }, approvalId: 'fake' }))
    expect(res.status).toBe(202)
    expect(execute).not.toHaveBeenCalled()
  })

  it('非法 action ⇒ 400；坏 JSON ⇒ 400；非 POST ⇒ 405', async () => {
    const handler = createWriteFetch(authz, createEchoExecutor(), 'owner', approvals())
    expect((await handler(post({ action: 'x' }))).status).toBe(400)
    expect((await handler(new Request('http://x/', { method: 'POST', body: '{ not' }))).status).toBe(400)
    expect((await handler(new Request('http://x/', { method: 'GET' }))).status).toBe(405)
  })

  it('⭐执行体抛**输入类**错误 ⇒ 400（invalid-input）；其余 ⇒ 500（execution-failed）', async () => {
    const withExecute = (execute: ConsoleActionExecutor): ReturnType<typeof createWriteFetch> =>
      createWriteFetch(authz, execute, 'owner', approvals())

    const inputRes = await withExecute(() => { throw new OfficeInputError('skill.create 需要 { slug }') })(
      post({ action: 'capability.toggle', payload: { id: 'x', on: true } }),
    )
    expect(inputRes.status).toBe(400)
    expect((await inputRes.json() as { code: string }).code).toBe('invalid-input')

    const execRes = await withExecute(() => { throw new Error('磁盘炸了') })(
      post({ action: 'capability.toggle', payload: { id: 'x', on: true } }),
    )
    expect(execRes.status).toBe(500)
    expect((await execRes.json() as { code: string }).code).toBe('execution-failed')
  })
})

describe('office-console · parseWriteInput', () => {
  it('合法输入（只认 action，可带 approvalId）', () => {
    expect(parseWriteInput({ action: 'config.edit', payload: { k: 1 } })).toEqual({ action: 'config.edit', payload: { k: 1 } })
    expect(parseWriteInput({ action: 'config.edit', approvalId: 'a1' })).toEqual({ action: 'config.edit', payload: undefined, approvalId: 'a1' })
  })
  it('非法/缺失 action → undefined', () => {
    expect(parseWriteInput({ action: 'x' })).toBeUndefined()
    expect(parseWriteInput({})).toBeUndefined()
    expect(parseWriteInput(null)).toBeUndefined()
  })
})
