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

/** 平台内置默认能力目录（L0）。 */
export const DEFAULT_CATALOG: readonly CatalogEntry[] = Object.freeze([
  // —— 技能：来自 office-skills（自研）——
  freezeEntry({
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
  freezeEntry({
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
  freezeEntry({
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
  freezeEntry({
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
  freezeEntry({
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
  freezeEntry({
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
  freezeEntry({
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
  freezeEntry({
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
  freezeEntry({
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
  freezeEntry({
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
 * 用一份目录造出只读查询服务。
 * @param entries - 目录内容，缺省为平台内置默认目录 `DEFAULT_CATALOG`。
 * @returns 只读 `OfficeCatalog`。
 */
export function createCatalogService(entries: readonly CatalogEntry[] = DEFAULT_CATALOG): OfficeCatalog {
  return {
    version: CATALOG_VERSION,
    list(kind) {
      const all = [...entries]
      return kind === undefined ? all : all.filter((entry) => entry.kind === kind)
    },
    get(id) {
      return entries.find((entry) => entry.id === id)
    },
    validate() {
      return validateCatalog(entries)
    },
  }
}
