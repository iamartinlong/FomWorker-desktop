/**
 * **用户自建 MCP 连接器的落地**（T4）：把表单值写成本地 bundle，并在 `catalog.local.json`
 * 里登记索引条目。形状照内核自带模板
 * （`dsh-agent-preset/skills/cordis-plugin-development/templates/mcp/`，详案 §6.1）。
 *
 * **`config.json` 是唯一真相，另外三个文件都由它生成**：
 * ```
 * $DSH_HOME/office/connectors/<slug>/
 *   ├── config.json       ← 表单值（唯一真相；JSON 模式编辑的就是它）
 *   ├── package.json      ← 生成（dsh.bundle.patch 指向下面的 patch）
 *   ├── cordis.patch.yml  ← 生成（insert @deepseek-ai/dsh-mcp-client）
 *   └── locale/en.json    ← 生成（最小：一个展示名）
 * ```
 * 这样做的理由：**不引入 YAML 解析器**（读回配置直接读 JSON），
 * 且「JSON 模式」天然就是编辑 `config.json`，与表单模式同源、不会漂。
 * 代价写明：**手改 `cordis.patch.yml` 会在下次保存时被覆盖**（以 config.json 为准）。
 *
 * 安装/卸载不在本模块——那由端点调内核 `pluginManager.installBundle` / `removeBundle`
 * （T5；`installBundle` 自己会 `loadOverlayPatches` + `selectBundle` + `publishAndReload`，
 * 详案 §6.2）。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CatalogEntry } from '../office-catalog/catalog.ts'
import { isValidSkillSlug } from '../office-skills/managed.ts'
import { MCP_TRANSPORTS } from './mcp-form.ts'

/** 用户自建连接器的根目录名（相对 `$DSH_HOME/office/`）。 */
export const CONNECTORS_DIR = 'connectors'

/** 本地 bundle 的包名前缀（与内核模板的 `@local/…` 一致）。 */
const LOCAL_SCOPE = '@local'

/** bundle 里 insert 的内核 MCP 客户端插件名（模板逐字）。 */
export const MCP_CLIENT_PLUGIN = '@deepseek-ai/dsh-mcp-client'

/** 内核 `Config` 里是数字的键（YAML 里要落成数字而不是字符串）。 */
const NUMERIC_KEYS: readonly string[] = ['toolCallTimeoutMs', 'maxInstructionBytes']

/** 一条待落地的用户自建连接器（表单值 + 展示信息）。 */
export interface ConnectorSpec {
  readonly slug: string
  /** 展示名（进 catalog.local.json 的 name）。 */
  readonly name: string
  /** 一句话说明（进 catalog.local.json 的 description）。 */
  readonly description: string
  /** MCP 服务名（内核 `serverName`，工具名前缀）。 */
  readonly serverName: string
  readonly transport: string
  /** 其余配置（command/args/env/cwd 或 url/headers…，已过分流）。 */
  readonly config: Readonly<Record<string, unknown>>
}

/**
 * 用户自建连接器根目录（`$DSH_HOME/office/connectors`）。
 * @param home - Harness home；缺省按内核口径（`DSH_HOME` 环境变量优先，否则 `~/.dsh`）。
 */
export function connectorsRoot(home?: string): string {
  const base = home ?? (process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh'))
  return join(base, 'office', CONNECTORS_DIR)
}

/** 单个连接器的目录。 */
export function connectorDir(root: string, slug: string): string {
  return join(root, slug)
}

/** slug 合法性（作目录名 + npm 包名）：复用技能那条判据。 */
export function isValidConnectorSlug(slug: string): boolean {
  return isValidSkillSlug(slug)
}

// ── YAML 生成（只生成，不解析）───────────────────────────────────────────────

/**
 * 一个标量的 YAML 表示（块上下文与流上下文共用一套规则）。
 *
 * 引号判据按 YAML 真实规则来，**不是「见特殊字符就加引号」**——那样会把
 * `https://example.com/mcp` 这种完全合法的裸标量也包起来（2026-11-05 首版就犯了这条，
 * 被自己的用例当场抓出）。真正需要引号的是：
 * 空串 · 长得像数字/布尔/null · 首尾空白 · 含 `: `（冒号+空格）或以 `:` 结尾 ·
 * 含 ` #`（空格+井号）· 含流上下文定界符 `,{}[]` · 以 YAML 指示符开头（`- ? ! & * | > % @ ` " '`）。
 * @param value - 字符串值。
 * @returns YAML 标量文本。
 */
function yamlScalar(value: string): string {
  const needsQuote = value === ''
    || /^[-+]?\d+(\.\d+)?$/u.test(value)
    || /^(true|false|yes|no|on|off|null|~)$/iu.test(value)
    || /^\s|\s$/u.test(value)
    || /:\s|\s#|:$/u.test(value)
    || /[,\{}\[\]]/u.test(value)
    || /^[-?!&*|>%@`"']/u.test(value)
  if (!needsQuote) return value
  return `'${value.replace(/'/gu, "''")}'`
}

/** 一个键的 YAML 表示（数字键落成裸数字）。 */
function yamlValue(key: string, value: unknown): string {
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === 'string')
    if (items.length === 0) return '[]'
    return `[${items.map((item) => yamlScalar(item)).join(', ')}]`
  }
  if (typeof value === 'object' && value !== null) {
    const pairs = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'string')
      .map(([k, v]) => `${k}: ${yamlScalar(v as string)}`)
    return pairs.length === 0 ? '{}' : `{${pairs.join(', ')}}`
  }
  const text = typeof value === 'string' ? value : String(value)
  return NUMERIC_KEYS.includes(key) && /^\d+$/u.test(text) ? text : yamlScalar(text)
}

/**
 * 生成 bundle 的 `cordis.patch.yml`（insert 一条 `dsh-mcp-client`）。
 * @param spec - 连接器规格。
 * @returns YAML 文本（LF 结尾）。
 */
export function renderBundlePatch(spec: ConnectorSpec): string {
  const config: Record<string, unknown> = {
    serverName: spec.serverName,
    transport: spec.transport,
    ...spec.config,
  }
  const lines = [
    '- insert:',
    `    - id: ${spec.slug}`,
    `      name: '${MCP_CLIENT_PLUGIN}'`,
    '      config:',
  ]
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined) continue
    lines.push(`        ${key}: ${yamlValue(key, value)}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * 生成 bundle 的 `package.json`（照内核模板：`dsh.bundle.patch` + locale exports）。
 * @param slug - 连接器 slug。
 * @returns JSON 文本（2 空格缩进 + LF 结尾）。
 */
export function renderBundlePackageJson(slug: string): string {
  return `${JSON.stringify({
    name: `${LOCAL_SCOPE}/${slug}`,
    version: '1.0.0',
    private: true,
    type: 'module',
    exports: { './locale/*.json': './locale/*.json' },
    files: ['cordis.patch.yml', 'locale/*.json'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, undefined, 2)}\n`
}

/** 生成最小 `locale/en.json`（只有一个展示名）。 */
export function renderLocaleEn(name: string): string {
  return `${JSON.stringify({ name }, undefined, 2)}\n`
}

/**
 * 写一个用户自建连接器（四个文件，整份覆盖）。
 * @param root - 连接器根目录。
 * @param spec - 连接器规格。
 * @returns 各文件绝对路径。
 */
export function writeConnectorBundle(root: string, spec: ConnectorSpec): {
  readonly dir: string
  readonly config: string
  readonly patch: string
} {
  if (!isValidConnectorSlug(spec.slug)) throw new Error(`非法连接器 slug：${spec.slug}`)
  if (!(MCP_TRANSPORTS as readonly string[]).includes(spec.transport)) {
    throw new Error(`不支持的传输类型：${spec.transport}（内核只认 ${MCP_TRANSPORTS.join(' / ')}）`)
  }
  const dir = connectorDir(root, spec.slug)
  mkdirSync(join(dir, 'locale'), { recursive: true })
  const configPath = join(dir, 'config.json')
  const patchPath = join(dir, 'cordis.patch.yml')
  const body = {
    slug: spec.slug,
    name: spec.name,
    description: spec.description,
    serverName: spec.serverName,
    transport: spec.transport,
    ...spec.config,
  }
  writeFileSync(configPath, `${JSON.stringify(body, undefined, 2)}\n`)
  writeFileSync(patchPath, renderBundlePatch(spec))
  writeFileSync(join(dir, 'package.json'), renderBundlePackageJson(spec.slug))
  writeFileSync(join(dir, 'locale', 'en.json'), renderLocaleEn(spec.name))
  return { dir, config: configPath, patch: patchPath }
}

/**
 * 删一个用户自建连接器（整目录；不存在返回 `false`）。
 * @param root - 连接器根目录。
 * @param slug - 连接器 slug。
 */
export function removeConnectorBundle(root: string, slug: string): boolean {
  const dir = connectorDir(root, slug)
  if (!existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

/**
 * 读回一个用户自建连接器的配置（`config.json`；不存在/坏 JSON ⇒ `undefined`）。
 * @param root - 连接器根目录。
 * @param slug - 连接器 slug。
 */
export function readConnectorConfig(root: string, slug: string): ConnectorSpec | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(connectorDir(root, slug), 'config.json'), 'utf8')) as Record<string, unknown>
    const { slug: s, name, description, serverName, transport, ...rest } = parsed
    if (typeof s !== 'string' || typeof serverName !== 'string' || typeof transport !== 'string') return undefined
    return {
      slug: s,
      name: typeof name === 'string' ? name : s,
      description: typeof description === 'string' ? description : '',
      serverName,
      transport,
      config: rest,
    }
  } catch {
    return undefined
  }
}

/**
 * 由连接器规格造 `catalog.local.json` 的索引条目（`origin` 由写文件那一侧强制为 `local`）。
 * @param spec - 连接器规格。
 */
export function localConnectorEntry(spec: ConnectorSpec): CatalogEntry {
  return {
    id: `connector:${spec.slug}`,
    kind: 'connector',
    name: spec.name,
    description: spec.description,
    version: '0.1.0',
    category: '自建',
    origin: 'local',
    defaultEnabled: true,
    source: { kind: 'mcp', ref: spec.slug },
    tags: [],
    spec: { transport: spec.transport, serverName: spec.serverName },
  }
}

/** 连接器根目录路径（便于测试与日志；`connectorsRoot` 的别名）。 */
export function connectorsRootPath(home?: string): string {
  return connectorsRoot(home)
}
