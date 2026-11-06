import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, createMeterService, name, type OfficeMeter } from './index.ts'

function fakeCtx(): { ctx: Context; provided: Map<string, unknown>; disposer: () => (() => void) | void | undefined } {
  const provided = new Map<string, unknown>()
  let disposer: (() => void) | void | undefined
  const ctx = {
    reflect: { provide: (key: string, value: unknown) => { provided.set(key, value); return () => { provided.delete(key) } } },
    effect: (setup: () => (() => void) | void) => { disposer = setup(); return disposer },
  }
  return { ctx: ctx as unknown as Context, provided, disposer: () => disposer }
}

describe('office-meter 插件壳', () => {
  it('name 正确', () => expect(name).toBe('office-meter'))

  it('apply 提供 officeMeter 服务，卸载后撤掉', () => {
    const fake = fakeCtx()
    apply(fake.ctx)
    const svc = fake.provided.get('officeMeter') as OfficeMeter
    expect(svc).toBeDefined()
    expect(typeof svc.collect).toBe('function')
    fake.disposer()?.()
    expect(fake.provided.has('officeMeter')).toBe(false)
  })

  it('createMeterService().collect 读一个 home 的 sessions/', () => {
    const home = mkdtempSync(join(tmpdir(), 'office-meter-home-'))
    try {
      const dir = join(home, 'sessions', '--cwd--', 's')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'session.v1.jsonl'), `${JSON.stringify({ type: 'assistant/message', time: Date.UTC(2026, 0, 3), data: { turn: 1, step: 1, usage: { inputTokens: 7, outputTokens: 1 } } })}\n`)
      const report = createMeterService().collect(home)
      expect(report.files).toBe(1)
      expect(createMeterService().byDay(report.sessions)['2026-01-03'].inputTokens).toBe(7)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
