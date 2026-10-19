/**
 * 导入包的**客户端浅检**（导入对话框里即时反馈用）。
 *
 * ⚠️ **权威校验在宿主**：`office-console/portable.ts` 的 `parsePortable*`（**响亮拒**、逐项报问题）。
 * 这里只做「是不是 JSON / `kind` 对不对 / 必备字段在不在」的**即时**反馈——不把 node 侧规则搬进浏览器；
 * 真正落盘前的把关仍由宿主的 400/500 消息给出（对话框会把它显示出来）。
 *
 * 纯模块（无 React / 无 IO），单测直接调。
 */

/** 技能包 `kind`（与宿主 `portable.ts` 同值）。 */
export const SKILL_KIND = 'fom-skill'
/** 专家包 `kind`（与宿主 `portable.ts` 同值）。 */
export const EXPERT_KIND = 'fom-expert'
/** 包格式版本（与宿主 `portable.ts` 同值）。 */
export const PORTABLE_VERSION = 1

/** 导入的类别。 */
export type ImportKind = 'skill' | 'expert'

/** 浅检结果。 */
export interface ImportCheck {
  readonly ok: boolean
  /** 给用户看的一句话（通过 / 第一个问题）。 */
  readonly message: string
  /** 包内标识（技能 `slug` / 专家 `id`），用于显示。 */
  readonly name?: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/**
 * 浅检一份导入文件文本。
 * @param kind - 期望类别（技能 / 专家）。
 * @param text - 文件文本（应为 JSON）。
 * @returns `{ ok, message, name? }`。
 */
export function checkImportFile(kind: ImportKind, text: string): ImportCheck {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, message: '不是合法 JSON' }
  }
  const record = asRecord(parsed)
  if (record === undefined) return { ok: false, message: '包不是 JSON 对象' }
  const expected = kind === 'skill' ? SKILL_KIND : EXPERT_KIND
  if (record.kind !== expected) {
    return { ok: false, message: `kind 应为 ${expected}（收到 ${JSON.stringify(record.kind)}）` }
  }
  if (record.version !== PORTABLE_VERSION) {
    return { ok: false, message: `version 应为 ${PORTABLE_VERSION}（收到 ${JSON.stringify(record.version)}）` }
  }
  if (kind === 'skill') {
    const slug = typeof record.slug === 'string' ? record.slug : ''
    const name = typeof record.name === 'string' ? record.name : ''
    const body = typeof record.body === 'string' ? record.body : ''
    if (slug === '' || name === '' || body === '') return { ok: false, message: '缺字段：slug / name / body 都要有' }
    return { ok: true, message: `格式检查通过：技能 ${slug}`, name: slug }
  }
  const id = typeof record.id === 'string' ? record.id : ''
  const name = typeof record.name === 'string' ? record.name : ''
  if (id === '' || name === '') return { ok: false, message: '缺字段：id / name 都要有' }
  return { ok: true, message: `格式检查通过：专家 ${id}`, name: id }
}
