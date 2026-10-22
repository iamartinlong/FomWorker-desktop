/**
 * 把**基座 ⊕ 专家 delta** 合成为内核 `agentPresets.register` 认的 preset 定义（C4）。纯函数。
 */

import { OFFICE_BASE, type PresetRow } from './base.ts'
import type { ExpertDelta } from './delta.ts'

/** 可变行（合成期就地改 `config`/`disabled`）。 */
interface MutableRow {
  id?: string
  name: string
  config?: unknown
  disabled?: boolean
  group?: boolean
  isolate?: Record<string, unknown>
}

/** 内核认的 preset 定义（结构最小面，不依赖内核类型导出）。 */
export interface PresetDefinition {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly order?: number
  readonly plugins: readonly PresetRow[]
}

function cloneRow(row: PresetRow): MutableRow {
  return {
    ...(row.id === undefined ? {} : { id: row.id }),
    name: row.name,
    ...(row.config === undefined ? {} : { config: structuredClone(row.config) }),
    ...(row.disabled === undefined ? {} : { disabled: row.disabled }),
    ...(row.group === undefined ? {} : { group: row.group }),
    ...(row.isolate === undefined ? {} : { isolate: { ...row.isolate } }),
  }
}

/**
 * 合成一个专家的**组合行**：基座逐行克隆 + 人设覆盖 + 工具勾选（`enable` ⇒ `disabled=false`、`disable` ⇒ `true`）。
 * @param delta - 专家 delta。
 * @returns 组合行（**新数组**，改不动基座）。
 */
export function composeExpertRows(delta: ExpertDelta): PresetRow[] {
  const rows = OFFICE_BASE.map(cloneRow)
  const byId = new Map<string, MutableRow>()
  for (const row of rows) if (row.id !== undefined) byId.set(row.id, row)
  if (delta.persona.prefix !== undefined || delta.persona.suffix !== undefined) {
    const persona = byId.get('persona')
    if (persona !== undefined) {
      const config = (persona.config ?? {}) as Record<string, unknown>
      persona.config = { ...config, ...delta.persona }
    }
  }
  for (const id of delta.tools.enable ?? []) {
    const row = byId.get(id)
    if (row !== undefined) row.disabled = false
  }
  for (const id of delta.tools.disable ?? []) {
    const row = byId.get(id)
    if (row !== undefined) row.disabled = true
  }
  // 技能勾选（C4b）：写进 office-skills 行的 config.skills（空＝不过滤）。
  const skillsRow = byId.get('office-skills')
  if (skillsRow !== undefined && delta.skills !== undefined) {
    skillsRow.config = { ...(skillsRow.config as Record<string, unknown> ?? {}), skills: delta.skills }
  }
  return rows
}

/**
 * 合成专家 preset 定义。
 * @param delta - 专家 delta。
 * @returns 内核 `agentPresets.register` 认的定义。
 */
export function composeExpert(delta: ExpertDelta): PresetDefinition {
  return {
    id: delta.id,
    name: delta.name,
    description: delta.description,
    ...(delta.order === undefined ? {} : { order: delta.order }),
    plugins: composeExpertRows(delta),
  }
}
