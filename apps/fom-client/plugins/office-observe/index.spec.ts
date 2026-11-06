import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, createObserveService, inject, name, type OfficeObserve } from './index.ts'
import { createMeterService } from '../office-meter/index.ts'
import { createAuditService } from '../office-audit/index.ts'

function fakeCtx(services: Record<string, unknown>): {
  ctx: Context
  provided: Map<string, unknown>
  disposer: () => (() => void) | void | undefined
  injects: ((c: unknown) => void)[]
} {
  const provided = new Map<string, unknown>()
  const injects: ((c: unknown) => void)[] = []
  let disposer: (() => void) | void | undefined
  const ctx = {
    get: (key: string) => services[key],
    reflect: { provide: (key: string, value: unknown) => { provided.set(key, value); return () => { provided.delete(key) } } },
    effect: (setup: () => (() => void) | void) => { disposer = setup(); return disposer },
    inject: (_deps: string[], cb: (c: unknown) => void) => { injects.push(cb); return () => {} },
  }
  return { ctx: ctx as unknown as Context, provided, disposer: () => disposer, injects }
}

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'office-observe-home-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function writeSession(lines: object[]): void {
  const dir = join(home, 'sessions', '--cwd--', 's1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v1.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
}

describe('office-observe 插件壳', () => {
  it('name / inject 正确', () => {
    expect(name).toBe('office-observe')
    expect(inject).toEqual(['officeMeter', 'officeAudit'])
  })

  it('apply 提供 officeObserve 服务，卸载后撤掉', () => {
    const fake = fakeCtx({ officeMeter: createMeterService(), officeAudit: createAuditService() })
    apply(fake.ctx)
    expect(fake.provided.get('officeObserve')).toBeDefined()
    fake.disposer()?.()
    expect(fake.provided.has('officeObserve')).toBe(false)
  })

  it('apply 缺服务时响亮抛', () => {
    expect(() => apply(fakeCtx({}).ctx)).toThrow(/officeMeter/)
  })

  it('createObserveService().snapshot 组合计量与审计', () => {
    writeSession([
      { type: 'tool/call', seq: 1, time: 10, data: { name: 'read', callId: 'c1', arguments: '{"file_path":"a.txt"}' } },
      { type: 'tool/result', seq: 2, time: 11, data: { turn: 1, step: 1, error: { name: 'E', code: 'E1' } } },
      { type: 'approval/asked', seq: 3, time: 20, data: { id: 'a', toolName: 'bash' } },
      { type: 'approval/decided', seq: 4, time: 50, data: { id: 'a', outcome: 'allowed-once' } },
      { type: 'assistant/message', seq: 5, time: Date.UTC(2026, 0, 5), data: { turn: 1, step: 1, usage: { inputTokens: 9, outputTokens: 2 } } },
    ])
    const svc: OfficeObserve = createObserveService(createMeterService(), createAuditService())
    const snap = svc.snapshot(home, 't1')
    expect(snap.tenant).toBe('t1')
    expect(snap.metrics.failures).toMatchObject({ toolCalls: 1, toolResults: 1, toolFailures: 1, failureRate: 1 })
    expect(snap.metrics.approval).toMatchObject({ decided: 1, pending: 0, avgMs: 30 })
    expect(snap.tokensByDay['2026-01-05'].inputTokens).toBe(9)
  })
})
