import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, localCatalogPath, name } from './index.ts'
import type { OfficeCatalog } from './catalog.ts'
import { writeManagedSkill } from '../office-skills/managed.ts'

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
  let home: string
  const previousHome = process.env.DSH_HOME

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'fom-catalog-'))
    process.env.DSH_HOME = home
  })
  afterEach(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })

  it('name 正确', () => {
    expect(name).toBe('office-catalog')
  })

  it('apply 在 officeCatalog 名下提供只读服务，卸载后撤掉（无本地文件＝仅平台源）', () => {
    const fake = fakeCtx()
    apply(fake.ctx)
    const svc = fake.provided.get('officeCatalog') as OfficeCatalog
    expect(svc).toBeDefined()
    expect(svc.validate()).toEqual([])
    expect(svc.list().length).toBeGreaterThan(0)
    expect(svc.list().every((entry) => entry.origin === 'platform')).toBe(true)
    fake.disposer()?.()
    expect(fake.provided.has('officeCatalog')).toBe(false)
  })

  it('两源合并：本地条在场、同名本地覆盖平台、平台独有保留', () => {
    mkdirSync(join(home, 'office'), { recursive: true })
    writeFileSync(localCatalogPath(home), JSON.stringify({
      schemaVersion: 1,
      entries: [
        { id: 'skill:meeting-minutes', kind: 'skill', name: '本地版会议纪要' },
        { id: 'skill:my-skill', kind: 'skill', name: '我的技能' },
      ],
    }))
    const fake = fakeCtx()
    apply(fake.ctx)
    const svc = fake.provided.get('officeCatalog') as OfficeCatalog
    expect(svc.get('skill:meeting-minutes')?.name).toBe('本地版会议纪要')
    expect(svc.get('skill:meeting-minutes')?.origin).toBe('local')
    expect(svc.get('skill:my-skill')?.origin).toBe('local')
    expect(svc.get('expert:psi')?.origin).toBe('platform')
  })

  it('新建的受管技能/专家**即时**出现在目录（本地源现读）', () => {
    const fake = fakeCtx()
    apply(fake.ctx)
    const svc = fake.provided.get('officeCatalog') as OfficeCatalog
    expect(svc.get('skill:live-skill')).toBeUndefined()
    // 模拟 skill.create / expert.create 写盘后，无需重启即应可见。
    writeManagedSkill(join(home, 'office', 'skills'), { slug: 'live-skill', name: '实时技能', description: 'd', body: 'b' })
    mkdirSync(join(home, 'office', 'presets'), { recursive: true })
    writeFileSync(join(home, 'office', 'presets', 'live-expert.json'), JSON.stringify({ id: 'live-expert', name: '实时专家', description: '', persona: {}, tools: {} }))
    expect(svc.get('skill:live-skill')?.name).toBe('实时技能')
    expect(svc.get('skill:live-skill')?.origin).toBe('local')
    expect(svc.get('expert:live-expert')?.name).toBe('实时专家')
    expect(svc.get('expert:live-expert')?.origin).toBe('local')
  })
})
