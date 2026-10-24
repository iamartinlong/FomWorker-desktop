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

  it('config.edit 接受（占位；skill.create 已改为真写，见下）', async () => {
    const execute = createConsoleExecutor({ store: createCapabilityStore(seed) })
    expect((await execute('config.edit', { k: 1 }) as { accepted: boolean }).accepted).toBe(true)
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

describe('office-console · 连接器装/卸 (connector.*)', () => {
  it('未注入 installer ⇒ dry-run（不真装）', async () => {
    const execute = createConsoleExecutor({ store: createCapabilityStore(seed) })
    expect(await execute('connector.install', { id: 'connector:b', ref: 'office-feishu' }))
      .toEqual({ dryRun: true, action: 'connector.install', id: 'connector:b', ref: 'office-feishu' })
  })

  it('注入 installer ⇒ 委托 + 翻转启用位（装→on，卸→off）', async () => {
    const installer: InstallerPort = { install: vi.fn(async (s) => ({ installed: s })), remove: vi.fn(async (s) => ({ removed: s })) }
    const store = createCapabilityStore(seed)
    const execute = createConsoleExecutor({ store, installer })
    const installed = await execute('connector.install', { id: 'connector:b', ref: 'office-feishu' }) as { connector: { enabled: boolean }; result: unknown }
    expect(installed.result).toEqual({ installed: 'office-feishu' })
    expect(installed.connector.enabled).toBe(true)
    expect(store.get('connector:b')?.enabled).toBe(true)
    await execute('connector.remove', { id: 'connector:b', ref: 'office-feishu' })
    expect(store.get('connector:b')?.enabled).toBe(false)
    expect(installer.remove).toHaveBeenCalledWith('office-feishu')
  })

  it('缺 id / ref 抛', async () => {
    const execute = createConsoleExecutor({ store: createCapabilityStore(seed), installer: { install: vi.fn(), remove: vi.fn() } })
    await expect(execute('connector.install', { ref: 'x' })).rejects.toThrow(/需要 \{ id \}/)
    await expect(execute('connector.install', { id: 'connector:b' })).rejects.toThrow(/需要 \{ ref \}/)
  })
})

describe('office-console · 技能创建/删除 (skill.*)', () => {
  it('未注入 skills ⇒ dry-run（不真写）', async () => {
    const execute = createConsoleExecutor({ store: createCapabilityStore(seed) })
    expect(await execute('skill.create', { slug: 's', name: 'n', body: 'b' }))
      .toEqual({ dryRun: true, action: 'skill.create', slug: 's' })
  })

  it('注入 skills ⇒ 写/删', async () => {
    const skills = { create: vi.fn(() => 'C:/x/SKILL.md'), remove: vi.fn(() => true), read: vi.fn(() => ({ slug: 's', name: 'n', description: 'd', body: 'b' })) }
    const execute = createConsoleExecutor({ store: createCapabilityStore(seed), skills })
    expect(await execute('skill.create', { slug: 's', name: 'n', description: 'd', body: 'b' }))
      .toEqual({ skill: { slug: 's', path: 'C:/x/SKILL.md' } })
    expect(skills.create).toHaveBeenCalledWith({ slug: 's', name: 'n', description: 'd', body: 'b' })
    expect(await execute('skill.remove', { slug: 's' })).toEqual({ skill: { slug: 's', removed: true } })
    expect(skills.remove).toHaveBeenCalledWith('s')
  })

  it('缺 slug / name / body 抛', async () => {
    const execute = createConsoleExecutor({ store: createCapabilityStore(seed), skills: { create: vi.fn(() => ''), remove: vi.fn(() => true), read: vi.fn(() => undefined) } })
    await expect(execute('skill.create', { name: 'n', body: 'b' })).rejects.toThrow(/需要 \{ slug \}/)
    await expect(execute('skill.create', { slug: 's', body: 'b' })).rejects.toThrow(/需要 \{ name \}/)
    await expect(execute('skill.create', { slug: 's', name: 'n' })).rejects.toThrow(/需要 \{ body \}/)
  })

  it('⭐非法 slug / id ⇒ **输入类**错误（code=invalid-input，写路由映射 400）', async () => {
    const skills = { create: vi.fn(() => ''), remove: vi.fn(() => true), read: vi.fn(() => undefined) }
    const execute = createConsoleExecutor({ store: createCapabilityStore(seed), skills })
    await expect(execute('skill.create', { slug: 'BAD', name: 'N', body: 'B' })).rejects.toMatchObject({ code: 'invalid-input' })

    const experts = { create: vi.fn(async () => ''), remove: vi.fn(() => true), read: vi.fn(() => undefined) }
    const execute2 = createConsoleExecutor({ store: createCapabilityStore(seed), experts })
    await expect(execute2('expert.create', { id: 'BAD', name: 'N' })).rejects.toMatchObject({ code: 'invalid-input' })
  })
})

describe('office-console · 专家创建/删除 (expert.*)', () => {
  it('未注入 experts ⇒ dry-run（不真写）', async () => {
    const execute = createConsoleExecutor({ store: createCapabilityStore(seed) })
    expect(await execute('expert.create', { id: 'e1', name: 'E1' }))
      .toEqual({ dryRun: true, action: 'expert.create', id: 'e1' })
  })

  it('注入 experts ⇒ 写/删', async () => {
    const experts = { create: vi.fn(async () => 'C:/x/presets/e1.json'), remove: vi.fn(() => true), read: vi.fn(() => ({ id: 'e1', name: 'E1', description: 'd', persona: {}, tools: {} })) }
    const execute = createConsoleExecutor({ store: createCapabilityStore(seed), experts })
    expect(await execute('expert.create', { id: 'e1', name: 'E1', description: 'd', persona: { prefix: 'p' }, tools: { enable: ['plan-mode'] }, skills: ['s'] }))
      .toEqual({ expert: { id: 'e1', path: 'C:/x/presets/e1.json' } })
    expect(experts.create).toHaveBeenCalledWith({ id: 'e1', name: 'E1', description: 'd', persona: { prefix: 'p' }, tools: { enable: ['plan-mode'] }, skills: ['s'] })
    expect(await execute('expert.remove', { id: 'e1' })).toEqual({ expert: { id: 'e1', removed: true } })
    expect(experts.remove).toHaveBeenCalledWith('e1')
  })

  it('缺 id / name 抛', async () => {
    const execute = createConsoleExecutor({ store: createCapabilityStore(seed), experts: { create: vi.fn(async () => ''), remove: vi.fn(() => true), read: vi.fn(() => undefined) } })
    await expect(execute('expert.create', { name: 'E1' })).rejects.toThrow(/需要 \{ id \}/)
    await expect(execute('expert.create', { id: 'e1' })).rejects.toThrow(/需要 \{ name \}/)
  })
})

describe('office-console · 导入/导出（C4e）', () => {
  it('未注入 ⇒ dry-run', async () => {
    const execute = createConsoleExecutor({ store: createCapabilityStore(seed) })
    expect(await execute('skill.export', { slug: 's' })).toEqual({ dryRun: true, action: 'skill.export', slug: 's' })
    expect(await execute('expert.export', { id: 'e1' })).toEqual({ dryRun: true, action: 'expert.export', id: 'e1' })
  })

  it('skill.export 读受管技能 → 包', async () => {
    const skills = { create: vi.fn(() => ''), remove: vi.fn(() => true), read: vi.fn(() => ({ slug: 's', name: 'N', description: 'D', body: 'B' })) }
    const execute = createConsoleExecutor({ store: createCapabilityStore(seed), skills })
    expect(await execute('skill.export', { slug: 's' })).toEqual({ bundle: { kind: 'fom-skill', version: 1, slug: 's', name: 'N', description: 'D', body: 'B' } })
  })

  it('skill.export 不存在 ⇒ 抛', async () => {
    const execute = createConsoleExecutor({ store: createCapabilityStore(seed), skills: { create: vi.fn(() => ''), remove: vi.fn(() => true), read: vi.fn(() => undefined) } })
    await expect(execute('skill.export', { slug: 'nope' })).rejects.toThrow(/技能不存在/)
  })

  it('skill.import 合法包 ⇒ 写入；非法包 ⇒ 响亮拒', async () => {
    const skills = { create: vi.fn(() => 'C:/x/SKILL.md'), remove: vi.fn(() => true), read: vi.fn(() => undefined) }
    const execute = createConsoleExecutor({ store: createCapabilityStore(seed), skills })
    const bundle = { kind: 'fom-skill', version: 1, slug: 's', name: 'N', description: 'D', body: 'B' }
    expect(await execute('skill.import', { bundle })).toEqual({ skill: { slug: 's', path: 'C:/x/SKILL.md' } })
    expect(skills.create).toHaveBeenCalledWith(bundle)
    await expect(execute('skill.import', { bundle: { kind: 'nope' } })).rejects.toThrow(/技能包非法/)
  })

  it('expert.export/import 往返', async () => {
    const experts = { create: vi.fn(async () => 'C:/x/presets/e1.json'), remove: vi.fn(() => true), read: vi.fn(() => ({ id: 'e1', name: 'E1', description: 'D', persona: { prefix: 'p' }, tools: { enable: ['plan-mode'] }, skills: ['s'] })) }
    const execute = createConsoleExecutor({ store: createCapabilityStore(seed), experts })
    const exported = await execute('expert.export', { id: 'e1' }) as { bundle: unknown }
    expect(exported.bundle).toEqual({ kind: 'fom-expert', version: 1, id: 'e1', name: 'E1', description: 'D', persona: { prefix: 'p' }, tools: { enable: ['plan-mode'] }, skills: ['s'] })
    expect(await execute('expert.import', { bundle: exported.bundle })).toEqual({ expert: { id: 'e1', path: 'C:/x/presets/e1.json' } })
  })
})
