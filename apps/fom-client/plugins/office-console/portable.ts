/**
 * **可分享包**（C4e）：用户**自己的**技能 / 专家的**单文件 JSON** 形态（导入 / 导出）。
 *
 * 口径（`能力目录动态化设计v0.1` §5 · C4e）：用户导入自己的包 → 校验包结构 → 写受管根 / 本地目录；
 * 导出本地自建项（可分享）；**非法包响亮拒**。归用户、不上报、平台不可见。
 *
 * 纯函数（**无文件 IO、无内核类型**）——IO 在 `index.ts` 的端口实现里；便于单测。
 */

import { isValidSkillSlug } from '../office-skills/managed.ts'
import { isValidExpertId, parseExpertDelta, type ExpertDelta } from '../office-experts/delta.ts'

/** 包格式版本（结构变更时递增；解析时须相等）。 */
export const PORTABLE_VERSION = 1

/** 技能包 `kind`。 */
export const SKILL_KIND = 'fom-skill'
/** 专家包 `kind`。 */
export const EXPERT_KIND = 'fom-expert'

/** 可分享的技能包。 */
export interface PortableSkill {
  readonly kind: typeof SKILL_KIND
  readonly version: number
  readonly slug: string
  readonly name: string
  readonly description: string
  readonly body: string
}

/** 可分享的专家包（= 专家 delta + 包头）。 */
export interface PortableExpert {
  readonly kind: typeof EXPERT_KIND
  readonly version: number
  readonly id: string
  readonly name: string
  readonly description: string
  readonly persona: { prefix?: string; suffix?: string }
  readonly tools: { enable?: string[]; disable?: string[] }
  readonly skills?: string[]
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/**
 * 把一个受管技能序列化成可分享包。
 * @param spec - 受管技能四元组。
 * @returns 技能包。
 */
export function exportSkill(spec: { slug: string; name: string; description: string; body: string }): PortableSkill {
  return { kind: SKILL_KIND, version: PORTABLE_VERSION, slug: spec.slug, name: spec.name, description: spec.description, body: spec.body }
}

/**
 * 把一个专家 delta 序列化成可分享包。
 * @param delta - 专家 delta。
 * @returns 专家包。
 */
export function exportExpert(delta: ExpertDelta): PortableExpert {
  return {
    kind: EXPERT_KIND,
    version: PORTABLE_VERSION,
    id: delta.id,
    name: delta.name,
    description: delta.description,
    persona: { ...delta.persona },
    tools: { ...delta.tools },
    ...(delta.skills === undefined ? {} : { skills: [...delta.skills] }),
  }
}

/**
 * 解析技能包（**响亮拒**：逐项报问题）。
 * @param value - 原始 JSON。
 * @returns 技能（合法时）与问题清单。
 */
export function parsePortableSkill(value: unknown): { skill?: PortableSkill; problems: string[] } {
  const problems: string[] = []
  const r = asRecord(value)
  if (r === undefined) return { problems: ['不是对象'] }
  if (r.kind !== SKILL_KIND) problems.push(`kind 须为 ${SKILL_KIND}（收到 ${JSON.stringify(r.kind)}）`)
  if (r.version !== PORTABLE_VERSION) problems.push(`version 须为 ${PORTABLE_VERSION}（收到 ${JSON.stringify(r.version)}）`)
  const slug = typeof r.slug === 'string' ? r.slug : ''
  const name = typeof r.name === 'string' ? r.name : ''
  const body = typeof r.body === 'string' ? r.body : ''
  if (!isValidSkillSlug(slug)) problems.push(`slug 非法：${JSON.stringify(r.slug)}`)
  if (name === '') problems.push('缺 name')
  if (body === '') problems.push('缺 body')
  if (problems.length > 0) return { problems }
  return {
    problems,
    skill: { kind: SKILL_KIND, version: PORTABLE_VERSION, slug, name, description: typeof r.description === 'string' ? r.description : '', body },
  }
}

/**
 * 解析专家包（**响亮拒**：逐项报问题；复用 `parseExpertDelta` 的字段校验）。
 * @param value - 原始 JSON。
 * @returns 专家（合法时）与问题清单。
 */
export function parsePortableExpert(value: unknown): { expert?: PortableExpert; problems: string[] } {
  const r = asRecord(value)
  if (r === undefined) return { problems: ['不是对象'] }
  const problems: string[] = []
  if (r.kind !== EXPERT_KIND) problems.push(`kind 须为 ${EXPERT_KIND}（收到 ${JSON.stringify(r.kind)}）`)
  if (r.version !== PORTABLE_VERSION) problems.push(`version 须为 ${PORTABLE_VERSION}（收到 ${JSON.stringify(r.version)}）`)
  const { delta, problems: deltaProblems } = parseExpertDelta(value)
  problems.push(...deltaProblems)
  if (problems.length > 0 || delta === undefined) return { problems }
  return { problems, expert: exportExpert(delta) }
}

/**
 * 从导入载荷猜包类型（`kind` 判别）。
 * @param value - 原始 JSON。
 * @returns 包类型；无法识别时 `undefined`。
 */
export function portableKind(value: unknown): 'skill' | 'expert' | undefined {
  const kind = asRecord(value)?.kind
  if (kind === SKILL_KIND) return 'skill'
  if (kind === EXPERT_KIND) return 'expert'
  return undefined
}

/** 专家 id 合法性（导入前预检，避免落盘才报）。 */
export { isValidExpertId }
