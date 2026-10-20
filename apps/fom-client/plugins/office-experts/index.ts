/**
 * `office-experts` 插件壳（C4）：把**专家 delta** 与**基座组合**合成 preset，注册进内核 `ctx.agentPresets`。
 *
 * 两源（对齐目录）：**基座**（`base.ts`，平台所有、随包维护）+ **专家 delta**（`$DSH_HOME/office/presets/*.json`，
 * 用户自建）。启动扫 delta → `composeExpert` → `register`；基座升级自动惠及所有专家。
 *
 * `inject:['agentPresets']` ⇒ 依赖内核 preset 注册表；服务不在（CLI 形态）就不装。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { composeExpert, type PresetDefinition } from './compose.ts'
import { EXPERT_PRESETS_DIR, listExpertDeltas, readExpertDelta, removeExpertDelta, writeExpertDelta, type ExpertDelta } from './delta.ts'
import { createExpertTools } from './tool.ts'

export * from './base.ts'
export * from './compose.ts'
export * from './delta.ts'
export * from './tool.ts'

export const name = 'office-experts'
export const inject = ['agentPresets', 'tools']

/** `agentPresets` 服务的最小面（只取 `register`，不依赖内核类型导出）。 */
interface AgentPresetsLike {
  register: (definition: PresetDefinition) => Promise<() => Promise<void>>
}

/** `tools` 服务的最小面（只取 `register`）。 */
interface ToolsLike {
  register: (tool: unknown) => () => void
}

/** 专家服务面（供控制台等消费：写 delta **并立即注册**）。 */
export interface OfficeExperts {
  /** 写 delta + 注册 preset；返回 delta 文件路径。 */
  create(delta: ExpertDelta): Promise<string>
  /** 删 delta + 注销 preset。 */
  remove(id: string): boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 专家写入口（由 `office-experts` 提供）。 */
    officeExperts: OfficeExperts
  }
}

/** 解析 `$DSH_HOME`（与内核一致：环境变量优先，否则 `~/.dsh`）。 */
export function resolveDshHome(): string {
  const home = process.env.DSH_HOME
  return home !== undefined && home !== '' ? home : join(homedir(), '.dsh')
}

/**
 * 专家 delta 目录。
 * @param home - Harness home，缺省 `$DSH_HOME`。
 * @returns `presets` 目录绝对路径。
 */
export function expertPresetsDir(home: string = resolveDshHome()): string {
  return join(home, 'office', EXPERT_PRESETS_DIR)
}

/**
 * 扫 delta 目录并合成 preset 定义（升序）。
 * @param dir - delta 目录。
 * @returns preset 定义（坏 delta 跳过）。
 */
export function loadExpertDefinitions(dir: string): PresetDefinition[] {
  const definitions: PresetDefinition[] = []
  for (const id of listExpertDeltas(dir)) {
    const delta = readExpertDelta(dir, id)
    if (delta !== undefined) definitions.push(composeExpert(delta))
  }
  return definitions
}

/**
 * 把专家注册进 `agentPresets`（卸载时逐个注销），挂 `expert_create` 工具（对话式创建），
 * 并提供 `officeExperts` 服务（供控制台表单创建 → **写 + 立即注册**，不必重启）。
 * @param ctx - 插件上下文。
 */
export function apply(ctx: Context): void {
  const presets = ctx.get('agentPresets') as AgentPresetsLike | undefined
  if (presets === undefined) throw new Error('office-experts: agentPresets 服务缺失')
  const tools = ctx.get('tools') as ToolsLike | undefined
  if (tools === undefined) throw new Error('office-experts: tools 服务缺失')
  const dir = expertPresetsDir()
  const disposers = new Map<string, () => Promise<void>>()
  const create = async (delta: ExpertDelta): Promise<string> => {
    const path = writeExpertDelta(dir, delta)
    // 立即注册 ⇒ 新建的专家不必重启即可召唤。
    const dispose = await presets.register(composeExpert(delta))
    disposers.set(delta.id, dispose)
    return path
  }
  const remove = (id: string): boolean => {
    const removed = removeExpertDelta(dir, id)
    const dispose = disposers.get(id)
    if (dispose !== undefined) {
      disposers.delete(id)
      void dispose()
    }
    return removed
  }
  ctx.effect(() => {
    const registrations = loadExpertDefinitions(dir).map((definition) => presets.register(definition))
    return () => {
      void Promise.allSettled(registrations).then((results) => Promise.allSettled(
        results.map((result) => result.status === 'fulfilled' ? result.value() : Promise.resolve()),
      ))
    }
  })
  ctx.effect(() => {
    const expertTools = createExpertTools({ create: async (delta) => ({ id: delta.id, path: await create(delta) }) })
    return tools.register(expertTools.create)
  })
  ctx.effect(() => ctx.reflect.provide('officeExperts', { create, remove }))
}

export default { name, inject, apply }
