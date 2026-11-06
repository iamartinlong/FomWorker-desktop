import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, createAuditService, name, type OfficeAudit } from './index.ts'

function fakeCtx(): { ctx: Context; provided: Map<string, unknown>; disposer: () => (() => void) | void | undefined } {
  const provided = new Map<string, unknown>()
  let disposer: (() => void) | void | undefined
  const ctx = {
    reflect: { provide: (key: string, value: unknown) => { provided.set(key, value); return () => { provided.delete(key) } } },
    effect: (setup: () => (() => void) | void) => { disposer = setup(); return disposer },
  }
  return { ctx: ctx as unknown as Context, provided, disposer: () => disposer }
}

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'office-audit-home-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function writeSession(dir: string, lines: object[]): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v1.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
}

describe('office-audit 插件壳', () => {
  it('name 正确', () => expect(name).toBe('office-audit'))

  it('apply 提供 officeAudit 服务，卸载后撤掉', () => {
    const fake = fakeCtx()
    apply(fake.ctx)
    const svc = fake.provided.get('officeAudit') as OfficeAudit
    expect(svc).toBeDefined()
    expect(typeof svc.collect).toBe('function')
    fake.disposer()?.()
    expect(fake.provided.has('officeAudit')).toBe(false)
  })

  it('createAuditService().collect 读一个 home 的 sessions/', () => {
    writeSession(join(home, 'sessions', '--cwd--', 's1'), [
      { type: 'tool/call', seq: 1, time: 10, data: { name: 'read', callId: 'c1', arguments: '{"file_path":"a.txt"}' } },
      { type: 'tool/result', seq: 2, time: 11, data: { turn: 1, step: 1, error: { name: 'E', code: 'X' } } },
      { type: 'assistant/message', seq: 3, time: 12, data: {} },
    ])
    const entries = createAuditService().collect(home, 't1')
    expect(entries.map((e) => e.type)).toEqual(['tool/call', 'tool/result'])
    expect(entries[0].tenant).toBe('t1')
    expect(entries[0].sessionId).toBe('s1')
    expect((entries[0].detail.kind === 'tool' && entries[0].detail.phase === 'call' ? entries[0].detail.paths : [])).toEqual(['a.txt'])
  })

  it('createAuditService().collectMany 跨租户合并', () => {
    writeSession(join(home, 'a', 'sessions', '--cwd--', 'sA'), [{ type: 'sandbox/mode', seq: 1, time: 1, data: { mode: 'read-only' } }])
    writeSession(join(home, 'b', 'sessions', '--cwd--', 'sB'), [{ type: 'model/selection', seq: 1, time: 2, data: { provider: 'p', model: 'm' } }])
    const entries = createAuditService().collectMany([
      { tenant: 't1', homeDir: join(home, 'a') },
      { tenant: 't2', homeDir: join(home, 'b') },
    ])
    expect(entries.map((e) => `${e.tenant}:${e.type}`)).toEqual(['t1:sandbox/mode', 't2:model/selection'])
  })
})
