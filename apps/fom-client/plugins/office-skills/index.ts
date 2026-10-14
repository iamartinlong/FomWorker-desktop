/**
 * 办公平台的**技能层**（SKILL.md 提供者）：把「会议纪要分发 / 周报汇总」等 IM 与组织上下文技能
 * 以 `SkillProvider` 形式挂进内核的 `ctx.skills`（形状抄内核 `skill-office`）。
 *
 * 为什么单独一层：内核的 `skill-filesystem` 只扫 `$DSH_HOME/skills`、`~/.agents/skills`、项目
 * `.dsh/skills`、`.agents/skills` 这些**目录**；办公平台的技能要跟代码一起走、可复现、可测，
 * 所以自建一个 provider（`inject:['skills']`），技能正文是随包的 `assets/<name>/SKILL.md`。
 *
 * 技能本身只是给模型的**指令**；它调用的能力来自 `office-feishu`（`feishu_doc_read` /
 * `feishu_doc_create` 等）与内核自带工具。技能不引入任何新工具、也不放宽任何闸。
 */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillProvider } from '@deepseek-ai/dsh-skill'

/** 本层提供的技能名（与 `assets/<name>/SKILL.md` 一一对应）。 */
const SKILLS = [
  {
    name: 'meeting-minutes',
    description: '把会议记录/转录整理成结构化会议纪要并分发：给出结论与待办（含负责人、期限），可发布为飞书云文档。当输入是会议录音转录、会议纪要文档，或用户要求「整理/分发会议纪要」时使用。',
  },
  {
    name: 'weekly-report',
    description: '汇总一周工作数据（多维表格记录 / 日历日程 / 工作区文件）生成结构化周报，可发布为飞书云文档。当用户要求「写周报 / 汇总本周工作」或提供了多维表格、日历数据时使用。',
  },
] as const

export interface OfficeSkillsConfig {
  /** 技能资产根目录（含各 `<name>/SKILL.md`）；缺省用随包的 `assets/`。 */
  assetRoot: string
}

const Config: z<OfficeSkillsConfig> = z.object({
  assetRoot: z.string().default(''),
})

export const name = 'office-skills'
export const inject = ['skills']

/** 去掉 YAML frontmatter，只留正文（本层的 SKILL.md frontmatter 只有 name/description）。 */
function skillBody(raw: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(raw)
  return (match === null ? raw : raw.slice(match[0].length)).trim()
}

/**
 * 造出技能提供者（与 `apply` 拆开，便于单测直接验 list/get，不必起 cordis）。
 * @param assetRoot - 技能资产根目录（绝对路径）。
 * @returns 内核 `ctx.skills` 认的 `SkillProvider`。
 */
export function createOfficeSkillsProvider(assetRoot: string): SkillProvider {
  if (!isAbsolute(assetRoot)) throw new Error('office-skills: assetRoot 必须是绝对路径')
  const candidates: SkillCandidate[] = SKILLS.map((skill) => {
    const directory = join(assetRoot, skill.name)
    const path = join(directory, 'SKILL.md')
    // 挂载时校验 SKILL.md 在场：缺了要**响亮抛**，不静默装一个没有正文的技能。
    readFileSync(path, 'utf8')
    return {
      name: skill.name,
      description: skill.description,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'dsh-office-platform',
      source: 'bundled',
      rank: BUNDLED_SKILL_RANK,
      resourceBase: { kind: 'directory', path: directory },
      locator: path,
    }
  })
  return {
    name: 'dsh-office-platform',
    list: () => Promise.resolve(candidates),
    async get(candidate, options) {
      const { rank: _rank, locator, ...summary } = candidate
      const raw = await readFile(locator as string, { encoding: 'utf8', signal: options.signal })
      return { ...summary, content: skillBody(raw) }
    },
  }
}

export function apply(ctx: Context, config: OfficeSkillsConfig): void {
  const assetRoot = config.assetRoot === ''
    ? fileURLToPath(new URL('./assets/', import.meta.url))
    : config.assetRoot
  ctx.skills.registerProvider(() => createOfficeSkillsProvider(assetRoot))
}

export const OfficeSkills = {
  name,
  inject,
  Config,
  apply,
}

export default OfficeSkills
