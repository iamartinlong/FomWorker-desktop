/**
 * 平台**默认能力目录**（L0）——把「平台预置的技能 / 专家 / 连接器」显式成一份**可被程序读**的结构化数据。
 *
 * 为什么单独一件：M1 的默认内容（`office-skills` 的会议纪要·周报、`office-feishu` 连接器、预设
 * agent）此前是**散落在各 bundle 里**的实体，没有一个「目录」能回答「平台到底提供了什么、哪个
 * 默认开着」。L1 用户自管理界面（M2）需要它当**数据源**：没有目录，界面就没东西可列。
 *
 * 边界（见 `docs/02-设计/M2前置调研与设计草案v0.1.md` §2.5）：本件只做 **L0**——一份只读目录 +
 * 校验；**不含 UI、不含安装动作、不含按 plan 的差分**（那些是 L1 / L2）。
 *
 * 纯数据 + 纯函数，不依赖 cordis，单测直接调；插件壳在 `index.ts`。
 */

/** 资源大类。 */
export type CatalogKind = 'skill' | 'expert' | 'connector'

/** 全部合法大类（校验与列举用，顺序稳定）。 */
export const CATALOG_KINDS: readonly CatalogKind[] = ['skill', 'expert', 'connector']

/** 条目来源：平台内置/下发（`platform`）或用户本地自建（`local`，不上报、平台不可见）。 */
export type CatalogOrigin = 'platform' | 'local'

/** 资源从哪来（决定日后 L1 的「安装」动作怎么落地）。 */
export interface CatalogSource {
  /** 声明/加载形态：随包 bundle / 技能提供者 / MCP 连接 / agent 预设。 */
  readonly kind: 'bundle' | 'skill-provider' | 'mcp' | 'agent-preset'
  /** 定位串（包名、`provider:name`、预设名等），不含密钥。 */
  readonly ref: string
}

/** 目录里的一条默认资源。 */
export interface CatalogEntry {
  /** 稳定 id，形如 `<kind>:<slug>`（校验会钉这条前缀约定）。 */
  readonly id: string
  readonly kind: CatalogKind
  /** 展示名（中文，平台默认以中文为准）。 */
  readonly name: string
  /** 一句话说明（面向用户）。 */
  readonly description: string
  /** 资源版本（目录自身的 schema 版本另有 `CATALOG_VERSION`）。 */
  readonly version: string
  /** 分类（对标千问/WorkBuddy 的「分类」，供 L1 筛选）。 */
  readonly category: string
  /** 来源：`platform`（平台内置/下发）或 `local`（本地自建，不上报）。 */
  readonly origin: CatalogOrigin
  /** L0 默认：平台是否为租户默认开启（L2 的「按 plan 差分」在此之上覆盖）。 */
  readonly defaultEnabled: boolean
  readonly source: CatalogSource
  readonly tags: readonly string[]
}

/** 目录 schema 版本。 */
export const CATALOG_VERSION = '0.1.0'

/** 深冻结一条条目（含 source 与 tags），防止消费方就地改写默认目录。 */
function freezeEntry(entry: CatalogEntry): CatalogEntry {
  Object.freeze(entry.source)
  Object.freeze(entry.tags)
  return Object.freeze(entry)
}

/** 标 `origin: 'platform'` 的条目（内置默认目录的每一条）。 */
function platformEntry(entry: Omit<CatalogEntry, 'origin'>): CatalogEntry {
  return freezeEntry({ ...entry, origin: 'platform' })
}

/** 平台内置默认能力目录（L0）。 */
export const DEFAULT_CATALOG: readonly CatalogEntry[] = Object.freeze([
  // —— 技能：来自 office-skills（自研）——
  platformEntry({
    id: 'skill:meeting-minutes',
    kind: 'skill',
    name: '会议纪要分发',
    description: '把会议记录/转录整理成结构化纪要（结论 + 待办含负责人与期限），可发布为飞书云文档。',
    version: '1.0.0',
    category: '办公协作',
    defaultEnabled: true,
    source: { kind: 'skill-provider', ref: 'office-skills:meeting-minutes' },
    tags: ['会议', '纪要', '飞书'],
  }),
  platformEntry({
    id: 'skill:weekly-report',
    kind: 'skill',
    name: '周报汇总',
    description: '汇总一周数据（多维表格 / 日历 / 工作区文件）生成结构化周报，可发布为飞书云文档。',
    version: '1.0.0',
    category: '办公协作',
    defaultEnabled: true,
    source: { kind: 'skill-provider', ref: 'office-skills:weekly-report' },
    tags: ['周报', '汇总'],
  }),
  // —— 技能：来自内核 skill-office（随平台默认挂载）——
  platformEntry({
    id: 'skill:office-docx',
    kind: 'skill',
    name: 'Word 文档',
    description: '生成与检查 .docx（含 OOXML 结构检查）。',
    version: '0.2.1-alpha.1',
    category: '文档',
    defaultEnabled: true,
    source: { kind: 'bundle', ref: '@deepseek-ai/dsh-skill-office' },
    tags: ['docx', 'office'],
  }),
  platformEntry({
    id: 'skill:office-pptx',
    kind: 'skill',
    name: '幻灯片',
    description: '生成与检查 .pptx。',
    version: '0.2.1-alpha.1',
    category: '文档',
    defaultEnabled: true,
    source: { kind: 'bundle', ref: '@deepseek-ai/dsh-skill-office' },
    tags: ['pptx', 'office'],
  }),
  platformEntry({
    id: 'skill:office-xlsx',
    kind: 'skill',
    name: '表格',
    description: '生成与检查 .xlsx。',
    version: '0.2.1-alpha.1',
    category: '文档',
    defaultEnabled: true,
    source: { kind: 'bundle', ref: '@deepseek-ai/dsh-skill-office' },
    tags: ['xlsx', 'office'],
  }),
  // —— 连接器：来自 office-feishu（自研）——
  platformEntry({
    id: 'connector:feishu',
    kind: 'connector',
    name: '飞书',
    description: '接入飞书：云文档读写、多维表格、日历，以及审批卡片收发。',
    version: '1.0.0',
    category: '接入',
    defaultEnabled: true,
    source: { kind: 'bundle', ref: 'office-feishu' },
    tags: ['IM', '飞书', '审批'],
  }),
  // —— 专家：内核默认 agent 预设（平台默认专家）——
  platformEntry({
    id: 'expert:standard',
    kind: 'expert',
    name: '通用办公助手',
    description: '默认专家：面向日常办公场景的通用 agent 组合。',
    version: '0.2.1-alpha.1',
    category: '专家',
    defaultEnabled: true,
    source: { kind: 'agent-preset', ref: 'standard' },
    tags: ['默认'],
  }),
  // —— 专家：业务域专家（PSI / PBM / PSP）——
  platformEntry({
    id: 'expert:psi',
    kind: 'expert',
    name: '数据分析与智能 PSI',
    description: '数据分析、市场数据分析；销售趋势预测、决策管理。',
    version: '1.0.0',
    category: '数据分析',
    defaultEnabled: true,
    source: { kind: 'agent-preset', ref: 'psi' },
    tags: ['数据分析', '预测', '决策'],
  }),
  platformEntry({
    id: 'expert:pbm',
    kind: 'expert',
    name: '移动化管理 PBM',
    description: '移动数据查询、移动数据交互；微信平台应用、APP 应用、智慧应用、万物互联。',
    version: '1.0.0',
    category: '移动化',
    defaultEnabled: true,
    source: { kind: 'agent-preset', ref: 'pbm' },
    tags: ['移动', '微信', 'APP', '物联网'],
  }),
  platformEntry({
    id: 'expert:psp',
    kind: 'expert',
    name: '流程与业务管理 PSP',
    description: '内部销售业务管理（主数据、费用控制、指标、奖金、预测等）；销售行为管理（CRM、拜访管理、渠道管理等）。',
    version: '1.0.0',
    category: '流程管理',
    defaultEnabled: true,
    source: { kind: 'agent-preset', ref: 'psp' },
    tags: ['CRM', '销售', '流程'],
  }),
])

/**
 * 校验一份目录：返回**问题清单**（空数组＝通过）。校验的是目录自身的完整性，
 * 不校验 `source.ref` 指向的东西是否真在场（那要装配期才知道）。
 * @param entries - 待校验条目。
 * @returns 人可读的问题列表；空＝合法。
 */
export function validateCatalog(entries: readonly CatalogEntry[]): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (entry.id === '') problems.push(`条目缺少 id（name=${entry.name}）`)
    if (!entry.id.startsWith(`${entry.kind}:`)) {
      problems.push(`id 前缀与 kind 不符：${entry.id} / ${entry.kind}（应为 ${entry.kind}:…）`)
    }
    if (seen.has(entry.id)) problems.push(`id 重复：${entry.id}`)
    seen.add(entry.id)
    if (entry.name === '') problems.push(`条目缺少 name：${entry.id}`)
    if (entry.description === '') problems.push(`条目缺少 description：${entry.id}`)
    if (entry.version === '') problems.push(`条目缺少 version：${entry.id}`)
    if (entry.category === '') problems.push(`条目缺少 category：${entry.id}`)
    if (entry.source.ref === '') problems.push(`条目缺少 source.ref：${entry.id}`)
    if (entry.origin !== 'platform' && entry.origin !== 'local') problems.push(`未知 origin：${String(entry.origin)}（${entry.id}）`)
    if (!CATALOG_KINDS.includes(entry.kind)) problems.push(`未知 kind：${entry.kind}（${entry.id}）`)
  }
  return problems
}

/** 平台默认能力目录服务的**只读**查询面（L1 的 host 服务将消费它）。 */
export interface OfficeCatalog {
  /** 目录 schema 版本。 */
  readonly version: string
  /** 列举全部条目，或按大类过滤（返回**新数组**，调用方改不动内部）。 */
  list(kind?: CatalogKind): CatalogEntry[]
  /** 按 id 取一条。 */
  get(id: string): CatalogEntry | undefined
  /** 校验目录完整性（供装配期与测试用）。 */
  validate(): string[]
}

/**
 * 合并两源目录（G7）：`platform`（平台内置/下发）+ `local`（本地自建）。**同名以本地为准**（U6）。
 * @param platform - 平台源条目（保序）。
 * @param local - 本地源条目（同名覆盖平台条）。
 * @returns **新数组**：未被本地覆盖的平台条 + 全部本地条。
 */
export function mergeCatalog(platform: readonly CatalogEntry[], local: readonly CatalogEntry[]): CatalogEntry[] {
  const localIds = new Set(local.map((entry) => entry.id))
  return [...platform.filter((entry) => !localIds.has(entry.id)), ...local]
}

/**
 * 用「平台源 + 本地源」造出只读查询服务（G7 两源）。
 *
 * `local` 可为**数组**（静态）或**函数**（**现读**）——后者用于「用户新建技能/专家后列表即时可见」：
 * 每次 `list()`/`get()` 重新调用它，读盘变化立刻反映，不必重启。
 * @param platform - 平台源，缺省为内置默认目录 `DEFAULT_CATALOG`。
 * @param local - 本地自建条目，或返回它们的函数（缺省空）。
 * @returns 只读 `OfficeCatalog`（两源合并视图）。
 */
export function createCatalogService(
  platform: readonly CatalogEntry[] = DEFAULT_CATALOG,
  local: readonly CatalogEntry[] | (() => readonly CatalogEntry[]) = [],
): OfficeCatalog {
  const localEntries = (): readonly CatalogEntry[] => (typeof local === 'function' ? local() : local)
  return {
    version: CATALOG_VERSION,
    list(kind) {
      const all = mergeCatalog(platform, localEntries())
      return kind === undefined ? all : all.filter((entry) => entry.kind === kind)
    },
    get(id) {
      return mergeCatalog(platform, localEntries()).find((entry) => entry.id === id)
    },
    validate() {
      return validateCatalog(mergeCatalog(platform, localEntries()))
    },
  }
}
