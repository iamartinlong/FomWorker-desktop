/**
 * **专家 delta**（C4）：专家的**可编辑部分**（人设 + 能力勾选），落 `$DSH_HOME/office/presets/<id>.json`。
 *
 * ⚠️ **只存 delta、不存全量组合** ⇒ 基座（`base.ts`）升级**自动惠及所有专家**。纯函数 + 文件读写；
 * 合成在 `compose.ts`，插件壳在 `index.ts`。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 专家 delta 目录名（相对 `$DSH_HOME/office/`）。 */
export const EXPERT_PRESETS_DIR = 'presets'

/** 一个专家的 delta。 */
export interface ExpertDelta {
  /** preset id（也是文件名）；slug 形态（小写字母数字起，允许 `.` `_` `-`）。 */
  readonly id: string
  readonly name: string
  readonly description: string
  readonly order?: number
  /** 人设覆盖（缺省用基座 persona）。 */
  readonly persona: { prefix?: string; suffix?: string }
  /** 工具勾选：`enable` 开（含高级能力）、`disable` 关；按基座行 id。 */
  readonly tools: { enable?: string[]; disable?: string[] }
  /** 技能勾选（技能名；C4b 由可过滤 provider 应用）。 */
  readonly skills?: string[]
}

/** id 合法性（作 preset id 与文件名）。 */
export function isValidExpertId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/u.test(id)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function strArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined
}

/**
 * 解析一个专家 delta（宽松：坏 id 报问题并丢弃；可选字段缺省补空）。
 * @param value - 原始 JSON。
 * @returns delta（合法时）与问题清单。
 */
export function parseExpertDelta(value: unknown): { delta?: ExpertDelta; problems: string[] } {
  const problems: string[] = []
  const r = asRecord(value)
  if (r === undefined) return { problems: ['delta 不是对象'] }
  const id = typeof r.id === 'string' ? r.id : ''
  const name = typeof r.name === 'string' ? r.name : ''
  if (!isValidExpertId(id)) problems.push(`id 非法：${JSON.stringify(r.id)}`)
  if (name === '') problems.push('缺 name')
  if (problems.length > 0) return { problems }
  const persona = asRecord(r.persona) ?? {}
  const tools = asRecord(r.tools) ?? {}
  return {
    problems,
    delta: {
      id,
      name,
      description: typeof r.description === 'string' ? r.description : '',
      ...(typeof r.order === 'number' ? { order: r.order } : {}),
      persona: {
        ...(typeof persona.prefix === 'string' ? { prefix: persona.prefix } : {}),
        ...(typeof persona.suffix === 'string' ? { suffix: persona.suffix } : {}),
      },
      tools: {
        ...(strArray(tools.enable) === undefined ? {} : { enable: strArray(tools.enable) }),
        ...(strArray(tools.disable) === undefined ? {} : { disable: strArray(tools.disable) }),
      },
      ...(strArray(r.skills) === undefined ? {} : { skills: strArray(r.skills) }),
    },
  }
}

/** 列 delta 文件 id（`<id>.json`，升序）。 */
export function listExpertDeltas(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -'.json'.length))
      .filter(isValidExpertId)
      .sort()
  } catch {
    return []
  }
}

/** 读一个 delta（不存在/坏 JSON → `undefined`）。 */
export function readExpertDelta(dir: string, id: string): ExpertDelta | undefined {
  try {
    return parseExpertDelta(JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'))).delta
  } catch {
    return undefined
  }
}

/** 写一个 delta（`<dir>/<id>.json`）；id 非法抛。 */
export function writeExpertDelta(dir: string, delta: ExpertDelta): string {
  if (!isValidExpertId(delta.id)) throw new Error(`非法专家 id：${delta.id}`)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${delta.id}.json`)
  writeFileSync(path, `${JSON.stringify(delta, undefined, 2)}\n`)
  return path
}

/** 删一个 delta。 */
export function removeExpertDelta(dir: string, id: string): boolean {
  if (!isValidExpertId(id)) return false
  const path = join(dir, `${id}.json`)
  if (!existsSync(path)) return false
  rmSync(path, { force: true })
  return true
}
