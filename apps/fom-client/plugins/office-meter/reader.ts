/**
 * 会话日志**读取器**（M2/A2）：扫一个 `$DSH_HOME/sessions` 目录，解码（zstd 或明文）、
 * 解析 JSONL、按会话折叠用量。
 *
 * 事实：内核会话日志布局 `<root>/--<normalized-cwd>--/<encoded-id>/session[.vN].jsonl[.zstd]`
 * （`packages/session/session-persistence-jsonl/README.md:54-72`），默认 zstd 压缩。Node ≥22.15 的
 * `node:zlib.zstdDecompressSync` 可解，无需引入内核模块。
 *
 * 同一会话目录可能有多代（`session.vN`）；**只取最高代**（含明文 `session.jsonl` 视为 v0），避免重复计数。
 */

import { readdirSync, readFileSync, type Dirent } from 'node:fs'
import { basename, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { foldSessionUsage, type SessionLogRecord, type SessionUsage } from './usage.ts'

/** 会话文件名：`session.jsonl`、`session.vN.jsonl`、可带 `.zstd`。 */
const SESSION_FILE = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/

/** 一次 `collect` 的报告。 */
export interface UsageReadReport {
  readonly sessions: SessionUsage[]
  /** 读到的会话文件数（每目录取最高代，故 ≈ 会话数）。 */
  readonly files: number
  /** 无法解析的行数（坏行；>0 说明日志被截断或有非 JSON 行）。 */
  readonly badLines: number
}

/** 目录内某会话文件的代号（v0 = 无后缀）。 */
function generationOf(name: string): number {
  const match = SESSION_FILE.exec(name)
  if (match === null) return -1
  return match[1] === undefined ? 0 : Number(match[1])
}

/** 解码一个会话文件为 utf8 文本（`.zstd` 走 node:zlib）。 */
function decodeFile(path: string): string {
  const buf = readFileSync(path)
  return path.endsWith('.zstd') ? zstdDecompressSync(buf).toString('utf8') : buf.toString('utf8')
}

/** 解析 JSONL 文本为记录数组，统计坏行。 */
function parseRecords(text: string): { records: SessionLogRecord[]; bad: number } {
  const records: SessionLogRecord[] = []
  let bad = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      records.push(JSON.parse(trimmed) as SessionLogRecord)
    } catch {
      bad += 1
    }
  }
  return { records, bad }
}

/** 一个会话的原始日志记录（`sessionId` = 会话目录名）。 */
export interface SessionLog {
  readonly sessionId: string
  readonly records: SessionLogRecord[]
}

/** 一个 `$DSH_HOME` 下所有会话的原始日志 + 读到的文件数 + 坏行数。 */
export interface SessionLogSet {
  readonly sessions: SessionLog[]
  readonly files: number
  readonly badLines: number
}

/**
 * 读取一个 `$DSH_HOME` 的 `sessions` 根下所有会话的**原始日志记录**（解码 + 解析，
 * 每个会话目录取最高代）。计量（本模块）与审计（`office-audit`）共用此读法。
 * @param sessionsRoot - `sessions` 目录（存在与否都可：不存在返回空集）。
 * @returns 各会话原始记录 + 文件数 + 坏行数。
 */
export function readSessionLogs(sessionsRoot: string): SessionLogSet {
  const sessions: SessionLog[] = []
  let files = 0
  let badLines = 0

  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    let best: { name: string; gen: number } | undefined
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!entry.isFile()) continue
      const gen = generationOf(entry.name)
      if (gen < 0) continue
      if (best === undefined || gen > best.gen) best = { name: entry.name, gen }
    }
    if (best !== undefined) {
      const path = join(dir, best.name)
      const { records, bad } = parseRecords(decodeFile(path))
      badLines += bad
      files += 1
      sessions.push({ sessionId: basename(dir), records })
    }
  }
  walk(sessionsRoot)
  return { sessions, files, badLines }
}

/**
 * 采集一个 `$DSH_HOME` 的 `sessions` 根下所有会话的用量。
 * @param sessionsRoot - `sessions` 目录（存在与否都可：不存在返回空报告）。
 * @returns 各会话用量 + 文件数 + 坏行数。
 */
export function collectSessionsUsage(sessionsRoot: string): UsageReadReport {
  const { sessions, files, badLines } = readSessionLogs(sessionsRoot)
  return {
    sessions: sessions.map((log) => foldSessionUsage(log.sessionId, log.records)),
    files,
    badLines,
  }
}
