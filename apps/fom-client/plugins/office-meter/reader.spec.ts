import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collectSessionsUsage } from './reader.ts'

let root: string

function line(usage: object): string {
  return `${JSON.stringify({ type: 'assistant/message', seq: 0, time: Date.UTC(2026, 0, 1), data: { turn: 1, step: 1, usage } })}\n`
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'office-meter-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('office-meter · 读取器 (collectSessionsUsage)', () => {
  it('读明文与 zstd 两种会话文件', () => {
    const a = join(root, '--cwd--', 'sessA')
    const b = join(root, '--cwd--', 'sessB')
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })
    writeFileSync(join(a, 'session.v1.jsonl'), line({ inputTokens: 10, outputTokens: 1 }))
    writeFileSync(join(b, 'session.v1.jsonl.zstd'), zstdCompressSync(Buffer.from(line({ inputTokens: 20, outputTokens: 2 }), 'utf8')))

    const report = collectSessionsUsage(root)
    expect(report.files).toBe(2)
    expect(report.badLines).toBe(0)
    const total = report.sessions.reduce((sum, s) => sum + s.summary.inputTokens, 0)
    expect(total).toBe(30)
  })

  it('同目录取最高代（不重复计数）', () => {
    const dir = join(root, '--cwd--', 'sessC')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v1.jsonl'), line({ inputTokens: 5, outputTokens: 0 }))
    writeFileSync(join(dir, 'session.v2.jsonl'), line({ inputTokens: 99, outputTokens: 0 }))
    const report = collectSessionsUsage(root)
    expect(report.files).toBe(1)
    expect(report.sessions[0].summary.inputTokens).toBe(99)
  })

  it('统计坏行', () => {
    const dir = join(root, '--cwd--', 'sessD')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v1.jsonl'), `${line({ inputTokens: 1, outputTokens: 0 })}{ not json\n`)
    const report = collectSessionsUsage(root)
    expect(report.badLines).toBe(1)
    expect(report.sessions[0].summary.inputTokens).toBe(1)
  })

  it('目录不存在返回空报告', () => {
    const report = collectSessionsUsage(join(root, 'nope'))
    expect(report.files).toBe(0)
    expect(report.sessions).toEqual([])
  })
})
