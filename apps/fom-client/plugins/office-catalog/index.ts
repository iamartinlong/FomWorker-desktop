/**
 * `office-catalog` 插件壳：把**两源合并**的能力目录以只读服务挂到 context（`officeCatalog`）。
 *
 * 两源（G7）：**平台源**（现为内置 `DEFAULT_CATALOG`；C5 起换成平台下发缓存）+ **本地源**
 * （`$DSH_HOME/office/catalog.local.json`，用户自建、不上报）。**同名以本地为准**（U6）。
 *
 * 下游（L1 用户自管理界面 / L2 运营后台）用 `inject:['officeCatalog']` 消费它。`apply` 只做一件事——
 * 读本地目录、与平台源合并、把只读服务暴露出去，并在卸载时撤掉。
 *
 * 无 `inject`（不依赖任何内核服务）、无 `Config`。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createCatalogService, DEFAULT_CATALOG, type CatalogEntry, type OfficeCatalog } from './catalog.ts'
import { LOCAL_CATALOG_FILE, readLocalCatalog } from './local-catalog.ts'
import { listManagedSkills, MANAGED_SKILLS_DIR, parseSkillFrontmatter, readManagedSkill } from '../office-skills/managed.ts'
import { PLATFORM_SKILLS_DIR } from '../office-skills/platform.ts'
import { EXPERT_PRESETS_DIR, listExpertDeltas, readExpertDelta } from '../office-experts/delta.ts'

export * from './catalog.ts'
export * from './local-catalog.ts'

export const name = 'office-catalog'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 能力目录（平台源 + 本地源合并，只读）。由本插件提供，声明即注入面。 */
    officeCatalog: OfficeCatalog
  }
}

/**
 * 解析 `$DSH_HOME`（与内核一致：环境变量优先，否则 `~/.dsh`）。
 * @returns Harness home 目录。
 */
export function resolveDshHome(): string {
  const home = process.env.DSH_HOME
  return home !== undefined && home !== '' ? home : join(homedir(), '.dsh')
}

/**
 * 本地自建目录文件路径。
 * @param home - Harness home，缺省 `$DSH_HOME`。
 * @returns `catalog.local.json` 的绝对路径。
 */
export function localCatalogPath(home: string = resolveDshHome()): string {
  return join(home, 'office', LOCAL_CATALOG_FILE)
}

/** 受管技能根（与 `office-skills` 同约定：`$DSH_HOME/office/skills`）。 */
export function managedSkillsRoot(home: string = resolveDshHome()): string {
  return join(home, 'office', MANAGED_SKILLS_DIR)
}

/**
 * 把受管技能根合成成**本地**目录条目（C3：用户自建技能在控制台里可见）。
 * @param root - 受管技能根。
 * @returns `origin='local'` 的技能条目。
 */
export function managedSkillEntries(root: string): CatalogEntry[] {
  return listManagedSkills(root).map((slug): CatalogEntry => {
    const raw = readManagedSkill(root, slug) ?? ''
    const meta = parseSkillFrontmatter(raw)
    return {
      id: `skill:${slug}`,
      kind: 'skill',
      name: meta.name ?? slug,
      description: meta.description ?? '',
      version: '0.1.0',
      category: '自建',
      origin: 'local',
      defaultEnabled: true,
      source: { kind: 'skill-provider', ref: `office-skills:${slug}` },
      tags: [],
    }
  })
}

/** 平台下发技能根（与 `office-skills` 同约定：`$DSH_HOME/office/platform-skills`）。 */
export function platformSkillsRoot(home: string = resolveDshHome()): string {
  return join(home, 'office', PLATFORM_SKILLS_DIR)
}

/**
 * 把平台下发技能根合成成**平台**目录条目（C5：sync 物化后在控制台里可见）。
 * @param root - 平台技能根。
 * @returns `origin='platform'` 的技能条目。
 */
export function platformSkillEntries(root: string): CatalogEntry[] {
  return listManagedSkills(root).map((slug): CatalogEntry => {
    const raw = readManagedSkill(root, slug) ?? ''
    const meta = parseSkillFrontmatter(raw)
    return {
      id: `skill:${slug}`,
      kind: 'skill',
      name: meta.name ?? slug,
      description: meta.description ?? '',
      version: '0.1.0',
      category: '平台下发',
      origin: 'platform',
      defaultEnabled: true,
      source: { kind: 'skill-provider', ref: `office-skills:${slug}` },
      tags: [],
    }
  })
}

/** 受管专家 delta 根（与 `office-experts` 同约定：`$DSH_HOME/office/presets`）。 */export function expertDeltasRoot(home: string = resolveDshHome()): string {
  return join(home, 'office', EXPERT_PRESETS_DIR)
}

/**
 * 把受管专家 delta 合成成**本地**目录条目（C4：用户自建专家在控制台里可见）。
 * @param root - delta 目录。
 * @returns `origin='local'` 的专家条目。
 */
export function expertEntries(root: string): CatalogEntry[] {
  return listExpertDeltas(root).map((id): CatalogEntry => {
    const delta = readExpertDelta(root, id)
    return {
      id: `expert:${id}`,
      kind: 'expert',
      name: delta?.name ?? id,
      description: delta?.description ?? '',
      version: '0.1.0',
      category: '自建',
      origin: 'local',
      defaultEnabled: true,
      source: { kind: 'agent-preset', ref: id },
      tags: [],
    }
  })
}

/**
 * 把两源合并的能力目录暴露为 context 服务（平台源 + 本地源；**本地源每次现读** ⇒ 新建后列表即时可见）。
 * @param ctx - 插件上下文。
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.reflect.provide('officeCatalog', createCatalogService(DEFAULT_CATALOG, () => [
    ...managedSkillEntries(managedSkillsRoot()),
    ...platformSkillEntries(platformSkillsRoot()),
    ...expertEntries(expertDeltasRoot()),
    ...readLocalCatalog(localCatalogPath()),
  ])))
}

export default { name, apply }
