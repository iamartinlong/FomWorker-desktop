/**
 * **平台下发技能物化**（C5）：把平台 `/api/config/catalog` 里的 `kind:'skill'` 条目写成
 * `<platformRoot>/<slug>/SKILL.md`——与**用户自建**（`managed.ts`）分开一棵树，来源标识 `origin:'platform'`。
 *
 * 纯函数 + 文件读写（无内核类型、无 IO 之外的副作用）；拉取在 `index.ts` 的 sync 里。
 * 口径（`能力目录动态化设计v0.1` §5 · C5）：下发是**真值**——不在下发集里的旧平台技能要**剪掉**；
 * **本地自建优先**（同名时受管根 rank 更小胜出）。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { listManagedSkills, removeManagedSkill, writeManagedSkill } from './managed.ts'

/** 平台下发技能根目录名（相对 `$DSH_HOME/office/`）。 */
export const PLATFORM_SKILLS_DIR = 'platform-skills'

/** 记录「已物化版本」的文件名（放平台根里；`listManagedSkills` 只认含 SKILL.md 的**目录** ⇒ 不会误列）。 */
export const APPLIED_FILE = '.applied.json'

/** 平台目录条目（只取用得到的字段）。 */
export interface PlatformCatalogEntry {
  readonly kind?: unknown
  readonly name?: unknown
  readonly version?: unknown
  readonly contentHash?: unknown
  readonly spec?: unknown
}

/** 一个平台技能（物化输入）。 */
export interface PlatformSkillSpec {
  readonly slug: string
  readonly name: string
  readonly description: string
  readonly body: string
  /** 平台给的版本（用于版本判定）。 */
  readonly version: string
  /** 平台给的内容指纹（用于版本判定）。 */
  readonly contentHash: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/**
 * 从一条平台目录条目抽出技能（`kind==='skill'` 且 `spec.slug`/`spec.body` 齐）；否则 `undefined`。
 * @param entry - 平台条目。
 * @returns 技能物化输入或 undefined。
 */
export function skillFromEntry(entry: unknown): PlatformSkillSpec | undefined {
  const record = asRecord(entry)
  if (record === undefined || record.kind !== 'skill') return undefined
  const spec = asRecord(record.spec)
  if (spec === undefined) return undefined
  const slug = typeof spec.slug === 'string' ? spec.slug : ''
  const body = typeof spec.body === 'string' ? spec.body : ''
  if (slug === '' || body === '') return undefined
  return {
    slug,
    name: typeof spec.name === 'string' && spec.name !== '' ? spec.name : slug,
    description: typeof spec.description === 'string' ? spec.description : '',
    body,
    version: typeof record.version === 'string' ? record.version : '',
    contentHash: typeof record.contentHash === 'string' ? record.contentHash : '',
  }
}

/** 一条已物化的记录（版本判定的依据）。 */
export interface AppliedSkill {
  readonly version: string
  readonly contentHash: string
}

/** 「已物化」表：slug → 版本 + 指纹。 */
export type AppliedMap = Record<string, AppliedSkill>

/** 一次物化的结果（**增量**：只写新/变了的，剪掉撤下的）。 */
export interface MaterializeResult {
  /** 新写的技能 slug（升序）。 */
  readonly written: string[]
  /** 内容变了的技能 slug（升序）。 */
  readonly updated: string[]
  /** 剪掉的旧平台技能 slug（升序）。 */
  readonly removed: string[]
  /** 未变、**跳过重写**的技能 slug（升序）。 */
  readonly unchanged: string[]
  /** 下发集里非技能条目数（跳过）。 */
  readonly skipped: number
  /** 本次物化后的「已物化」表（供落盘）。 */
  readonly applied: AppliedMap
}

/** 读「已物化」表（不存在/坏 JSON → 空表）。 */
export function readApplied(root: string): AppliedMap {
  try {
    const parsed = JSON.parse(readFileSync(join(root, APPLIED_FILE), 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as AppliedMap
  } catch {
    return {}
  }
}

/** 写「已物化」表。 */
export function writeApplied(root: string, applied: AppliedMap): void {
  writeFileSync(join(root, APPLIED_FILE), `${JSON.stringify(applied, undefined, 2)}\n`)
}

/**
 * 物化平台技能（**版本判定 / 增量**）：`(version, contentHash)` 未变的**跳过重写**；
 * 新/变了的写 `<root>/<slug>/SKILL.md`；**剪掉**不在下发集里的旧平台技能。
 * 非法 slug 由 `writeManagedSkill` 响亮抛（不静默跳过）。
 * @param root - 平台技能根（绝对路径）。
 * @param entries - 平台目录条目数组。
 * @param applied - 上一次的「已物化」表（缺省空 ⇒ 全写）。
 * @returns 写/更/删/跳过清单 + 新的「已物化」表。
 */
export function materializePlatformSkills(root: string, entries: readonly unknown[], applied: AppliedMap = {}): MaterializeResult {
  const skills = new Map<string, PlatformSkillSpec>()
  let skipped = 0
  for (const entry of entries) {
    const skill = skillFromEntry(entry)
    if (skill === undefined) {
      skipped += 1
      continue
    }
    skills.set(skill.slug, skill)
  }
  const written: string[] = []
  const updated: string[] = []
  const unchanged: string[] = []
  const next: AppliedMap = {}
  for (const [slug, skill] of skills) {
    const previous = applied[slug]
    const same = previous !== undefined && previous.version === skill.version && previous.contentHash === skill.contentHash
    if (same) {
      unchanged.push(slug)
    } else {
      writeManagedSkill(root, skill)
      if (previous === undefined) written.push(slug)
      else updated.push(slug)
    }
    next[slug] = { version: skill.version, contentHash: skill.contentHash }
  }
  const removed: string[] = []
  for (const slug of listManagedSkills(root)) {
    if (!skills.has(slug)) {
      removeManagedSkill(root, slug)
      removed.push(slug)
    }
  }
  return {
    written: written.sort(),
    updated: updated.sort(),
    removed: removed.sort(),
    unchanged: unchanged.sort(),
    skipped,
    applied: next,
  }
}
