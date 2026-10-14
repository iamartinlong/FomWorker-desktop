import { describe, expect, it, vi } from 'vitest'
import { createCapabilityStore, createConsoleExecutor, type InstallerPort } from './executor.ts'
import { createApprovalStore } from './approvals.ts'

const seed = [{ id: 'skill:a', enabled: true }, { id: 'connector:b', enabled: false }]

describe('office-console · 能力存储', () => {
  it('list/get/setEnabled', () => {
    const store = createCapabilityStore(seed)
    expect(store.list().map((s) => s.id).sort()).toEqual(['connector:b', 'skill:a'])
    expect(store.get('skill:a')?.enabled).toBe(true)
    expect(store.setEnabled('skill:a', false)?.enabled).toBe(false)
    expect(store.get('skill:a')?.enabled).toBe(false)
    expect(store.setEnabled('nope', true)).toBeUndefined()
  })
})

describe('office-console · 真实执行体', () => {
  it('capability.toggle 翻转真实状态', async () => {
    const store = createCapabilityStore(seed)
    const execute = createConsoleExecutor({ store })
    const out = await execute('capability.toggle', { id: 'connector:b', on: true })
    expect(out).toEqual({ capability: { id: 'connector:b', enabled: true } })
    expect(store.get('connector:b')?.enabled).toBe(true)
  })

  it('capability.toggle 未知能力抛', async () => {
    const execute = createConsoleExecutor({ store: createCapabilityStore(seed) })
    await expect(execute('capability.toggle', { id: 'nope', on: true })).rejects.toThrow(/未知能力/)
  })

  it('capability.toggle 参数缺失抛', async () => {
    const execute = createConsoleExecutor({ store: createCapabilityStore(seed) })
    await expect(execute('capability.toggle', { id: 'skill:a' })).rejects.toThrow(/需要 \{ id, on \}/)
  })

  it('bundle.install 未注入 installer ⇒ dry-run（不真装）', async () => {
    const execute = createConsoleExecutor({ store: createCapabilityStore(seed) })
    const out = await execute('bundle.install', { spec: '@x/y' })
    expect(out).toEqual({ dryRun: true, action: 'bundle.install', spec: '@x/y' })
  })

  it('bundle.install/remove 注入 installer ⇒ 委托', async () => {
    const installer: InstallerPort = { install: vi.fn(async (s) => ({ installed: s })), remove: vi.fn(async (s) => ({ removed: s })) }
    const execute = createConsoleExecutor({ store: createCapabilityStore(seed), installer })
    expect(await execute('bundle.install', { spec: '@x/y' })).toEqual({ result: { installed: '@x/y' } })
    expect(await execute('bundle.remove', { spec: '@x/y' })).toEqual({ result: { removed: '@x/y' } })
    expect(installer.install).toHaveBeenCalledTimes(1)
  })

  it('bundle.install 缺 spec 抛', async () => {
    const execute = createConsoleExecutor({ store: createCapabilityStore(seed) })
    await expect(execute('bundle.install', {})).rejects.toThrow(/需要 \{ spec \}/)
  })

  it('config.edit / skill.create 接受', async () => {
    const execute = createConsoleExecutor({ store: createCapabilityStore(seed) })
    expect((await execute('config.edit', { k: 1 }) as { accepted: boolean }).accepted).toBe(true)
    expect((await execute('skill.create', {}) as { accepted: boolean }).accepted).toBe(true)
  })
})

describe('office-console · 审批裁决 (approval.decide)', () => {
  it('未注入审批存储 ⇒ 抛', async () => {
    const execute = createConsoleExecutor({ store: createCapabilityStore(seed) })
    await expect(execute('approval.decide', { id: 'a1', decision: 'grant' })).rejects.toThrow(/未注入审批存储/)
  })

  it('grant 经存储', async () => {
    const approvals = createApprovalStore(() => 'a1')
    approvals.request('bundle.install', { spec: '@x/y' })
    const execute = createConsoleExecutor({ store: createCapabilityStore(seed), approvals })
    const out = await execute('approval.decide', { id: 'a1', decision: 'grant' }) as { approval: { id: string; status: string } }
    expect(out.approval.id).toBe('a1')
    expect(out.approval.status).toBe('granted')
  })

  it('缺 decision 抛；未知/非 pending id 抛', async () => {
    const execute = createConsoleExecutor({ store: createCapabilityStore(seed), approvals: createApprovalStore(() => 'a1') })
    await expect(execute('approval.decide', { id: 'a1' })).rejects.toThrow(/grant\|reject/)
    await expect(execute('approval.decide', { id: 'a1', decision: 'grant' })).rejects.toThrow(/不可裁决/)
  })
})
