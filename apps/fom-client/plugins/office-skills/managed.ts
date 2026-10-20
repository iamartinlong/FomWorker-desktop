/**
 * **受管技能根**（C3）：`<managedRoot>/<slug>/SKILL.md`——用户自建技能落这里，由 `office-skills` 的
 * **managed provider** 扫进内核 `ctx.skills`（agent 随即可用）。**不上报、平台不可见**（同本地目录）。
 *
 * 纯函数 + 文件读写（不含内核类型）；provider 在 `index.ts`。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 受管技能根目录名（相对 `$DSH_HOME/office/`）。 */
export const MANAGED_SKILLS_DIR = 'skills'

/** 一个待写入的技能。 */
export interface ManagedSkillSpec {
  readonly slug: string
  readonly name: string
  readonly description: string
  readonly body: string
}

/** slug 合法性（作目录名）：小写字母数字起，允许 `.` `_` `-`。 */
export function isValidSkillSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/u.test(slug)
}

/** 渲染 SKILL.md（YAML frontmatter + 正文）。 */
export function renderSkillMarkdown(spec: ManagedSkillSpec): string {
  return `---\nname: ${spec.name}\ndescription: ${spec.description}\n---\n\n${spec.body.trim()}\n`
}

/** 解析 SKILL.md frontmatter 的 `name`/`description`（缺失返回 `{}`）。 */
export function parseSkillFrontmatter(raw: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(raw)
  if (match === null) return {}
  const out: { name?: string; description?: string } = {}
  for (const line of match[1].split(/\r?\n/u)) {
    const m = /^(name|description):\s*(.*)$/u.exec(line.trim())
    if (m !== null) out[m[1] as 'name' | 'description'] = m[2].trim()
  }
  return out
}

/** 去掉 YAML frontmatter，只留正文。 */
export function skillBody(raw: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(raw)
  return (match === null ? raw : raw.slice(match[0].length)).trim()
}

/** 写受管技能（`<root>/<slug>/SKILL.md`）；slug 非法抛。 */
export function writeManagedSkill(root: string, spec: ManagedSkillSpec): string {
  if (!isValidSkillSlug(spec.slug)) throw new Error(`非法技能 slug：${spec.slug}`)
  const directory = join(root, spec.slug)
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'SKILL.md')
  writeFileSync(path, renderSkillMarkdown(spec))
  return path
}

/** 删受管技能目录（不存在 / slug 非法 → `false`）。 */
export function removeManagedSkill(root: string, slug: string): boolean {
  if (!isValidSkillSlug(slug)) return false
  const directory = join(root, slug)
  if (!existsSync(directory)) return false
  rmSync(directory, { recursive: true, force: true })
  return true
}

/** 列受管技能 slug（含 `SKILL.md` 的目录，升序）。 */
export function listManagedSkills(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'SKILL.md')))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/** 读受管技能 `SKILL.md` 原文。 */
export function readManagedSkill(root: string, slug: string): string | undefined {
  try {
    return readFileSync(join(root, slug, 'SKILL.md'), 'utf8')
  } catch {
    return undefined
  }
}
