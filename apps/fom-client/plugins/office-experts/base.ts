/**
 * **办公助理基座组合**（C4）：我们的「专家」在它之上做 delta。
 *
 * ⚠️ **这是我们的产品资产，不是内核 `standard` 的快照**——内核 `standard` 是**编码 agent**
 * （persona「You are a coding agent」、含 `tool-bash`），与办公助理不符。本基座**自建、随包维护**：
 * 办公助理核心（fs/todo/web/skill/schedule/ask-user/present + 压缩）+ 高级能力（subagent/plan，**默认关**）。
 *
 * 只含**行数据**（`name` + `config` + `disabled`）；不依赖内核类型。合成在 `compose.ts`。
 */

/** 一条 preset 组合行（结构上等同内核 `EntryOptions` 的最小面）。 */
export interface PresetRow {
  readonly id?: string
  readonly name: string
  readonly config?: unknown
  readonly disabled?: boolean
  readonly group?: boolean
  readonly isolate?: Readonly<Record<string, unknown>>
}

/** 基座 persona 的默认前缀（办公助理；内核 `standard` 那句是编码 agent，不采用）。 */
export const OFFICE_PERSONA_PREFIX = '你是 FomWorker 办公助理，帮助员工完成日常办公任务：文档与表格、会议纪要、信息检索、日程与待办、交付物生成等。'

/** 基座 persona 的默认后缀。 */
export const OFFICE_PERSONA_SUFFIX = '当前工作目录：{{cwd}}。'

/**
 * 办公助理**基座组合**（核心 + 高级默认关）。
 * 行 `id` 稳定，供专家 delta 按 id 开/关（`tools.enable`/`tools.disable`）。
 */
export const OFFICE_BASE: readonly PresetRow[] = Object.freeze([
  { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: OFFICE_PERSONA_PREFIX, suffix: OFFICE_PERSONA_SUFFIX } },
  { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
  { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
  { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
  { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
  { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
  { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
  { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
  { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
  { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
  // 办公技能 provider（C4b）：专家组合挂它 ⇒ 覆盖全局同名 provider、**只带选中技能**（delta.skills）。
  { id: 'office-skills', name: '@office/skills', config: {} },
  { id: 'tool-schedule', name: '@deepseek-ai/dsh-tool-schedule' },
  { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
  {
    id: 'compaction',
    name: 'cordis:group',
    group: true,
    isolate: { compaction: true, toolResultPruner: true },
    config: [
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
      { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
      { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner', config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 } },
    ],
  },
  // —— 高级能力（默认关；专家可勾选开启）——
  // ⚠️ 内核要求 `plan-mode` / `tool-subagent` 落在**带 isolate 的组**里（真进程实测：平铺会
  // `Preset services require isolate realms: planMode`）⇒ 照内核 `standard` 用 `cordis:group` + `isolate` 包一层。
  {
    id: 'plan-mode',
    name: 'cordis:group',
    group: true,
    isolate: { planMode: true },
    disabled: true,
    config: [
      {
        id: 'plan-mode-plugin',
        name: '@deepseek-ai/dsh-plan-mode',
        config: {
          section: 'You are in plan mode. Explore first with non-mutating reads, then submit a decision-complete plan through exit_plan_mode. Do not edit or write files until the plan is approved.',
        },
      },
    ],
  },
  {
    id: 'tool-subagent',
    name: 'cordis:group',
    group: true,
    isolate: { workflowEngine: true },
    disabled: true,
    config: [
      {
        id: 'tool-subagent-plugin',
        name: '@deepseek-ai/dsh-tool-subagent',
        config: { provider: 'spawn', toolName: 'subagent', modelSelectionSettings: true, backgroundMode: 'continuable' },
      },
    ],
  },
])

/** 基座里可被专家勾选的**高级能力**（默认关）行 id。 */
export const ADVANCED_ROW_IDS: readonly string[] = Object.freeze(['tool-subagent', 'plan-mode'])
