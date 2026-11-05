/**
 * **`expert_create` 工具**（C4d）：把「创建专家」交给模型——用户在对话里说清岗位/人设/能力，
 * agent 调本工具把专家**沉淀**下来（写 delta + 立即注册 preset）。这就是「**对话式创建**」的主路径。
 *
 * 只暴露给模型一个**受控写入口**（写自家 `$DSH_HOME/office/presets`），不经工作区沙箱、不放宽闸。
 * 参数用**逗号分隔**的字符串（`tools`/`skills`）而非数组，减少模型构造数组的出错面。
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ExpertDelta } from './delta.ts'

/** 工具写入口：写 delta **并立即注册**（新专家不必重启即可召唤）。 */
export interface ExpertCreatePort {
  create(delta: ExpertDelta): Promise<{ id: string; path: string }>
}

/** 把逗号分隔串拆成去空数组（空/全空 → `undefined`）。 */
function csv(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined
  const items = value.split(',').map((item) => item.trim()).filter((item) => item !== '')
  return items.length === 0 ? undefined : items
}

/**
 * 造 `expert_create` 工具。
 * @param port - 写入口（写 delta + 注册）。
 * @returns 工具定义。
 */
export function createExpertTools(port: ExpertCreatePort): { create: ToolDefinition } {
  const create = defineTool({
    name: 'expert_create',
    description:
      '创建一个「专家」（可召唤的 agent preset）：人设 + 能力勾选。用它把用户描述的岗位/角色/工作方法'
      + '沉淀成一个专家。创建前先问清：名称、人设（是谁 + 什么背景 + 擅长什么）、要不要开高级能力（plan-mode / tool-subagent）。'
      + '专家不绑模型（模型在对话框里选）。',
    parameters: {
      id: { type: 'string', required: true, description: '专家标识：小写字母数字与 `.` `_` `-`，作文件名，如 `contract-review`。' },
      name: { type: 'string', required: true, description: '展示名，如「合同审阅官」。' },
      description: { type: 'string', description: '一句话说明。' },
      personaPrefix: { type: 'string', description: '人设前缀：是谁 + 有什么背景（不要写成任务本身）。' },
      personaSuffix: { type: 'string', description: '人设后缀：补充约束（如「不确定时先问，不要臆测」）。' },
      tools: { type: 'string', description: '要开启的**高级能力**，逗号分隔（可选 `plan-mode`、`tool-subagent`）。' },
      skills: { type: 'string', description: '要带的技能名，逗号分隔（可选）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          path: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已创建专家 ${value.id}（${value.path}）` }],
    },
    async execute(args) {
      const enabledTools = csv(args.tools)
      const skills = csv(args.skills)
      const delta: ExpertDelta = {
        id: args.id,
        name: args.name,
        description: args.description ?? '',
        persona: {
          ...(args.personaPrefix === undefined || args.personaPrefix === '' ? {} : { prefix: args.personaPrefix }),
          ...(args.personaSuffix === undefined || args.personaSuffix === '' ? {} : { suffix: args.personaSuffix }),
        },
        tools: { ...(enabledTools === undefined ? {} : { enable: enabledTools }) },
        ...(skills === undefined ? {} : { skills }),
      }
      const result = await port.create(delta)
      return { id: result.id, path: result.path }
    },
  })
  return { create }
}
