/**
 * **用户自建连接器**的增删查（T5a）：把表单值落成本地 bundle + 登记索引 + 调内核装卸。
 *
 * 与「平台层配置」的分界（详案 §5）：本模块只做 **`origin: 'local'` 的用户自建层；
 * 平台层（飞书等插件型）的配置要写 profile patch，那是 T5b 的事——那边需要 YAML 读写，
 * 不该和这边混成一锅。
 *
 * **安装闸**：`installer` 缺省即 dry-run（只落文件、不真装）——装 bundle 是 root 等价动作，
 * 沿用 `office-console` 既有的 `enableInstaller` 口径，**不发明第二个开关**。
 * 真装由内核 `pluginManager.installBundle(spec)` / `removeBundle(name)` 完成
 * （它自己会 loadOverlayPatches + selectBundle + publishAndReload，详案 §6.2）。
 */

import { join } from 'node:path'
import type { CatalogEntry } from '../office-catalog/catalog.ts'
import { LOCAL_CATALOG_FILE, readLocalCatalog, writeLocalCatalog } from '../office-catalog/local-catalog.ts'
import { isValidSkillSlug } from '../office-skills/managed.ts'
import { defaultsOf, missingRequired, splitFormValues, type ConfigForm } from './connector-form.ts'
import {
  connectorsRoot,
  localConnectorEntry,
  readConnectorConfig,
  removeConnectorBundle,
  writeConnectorBundle,
  type ConnectorSpec,
} from './connector-bundle.ts'
import { mcpConfigForm, serverNameProblem, transportOfSpec } from './mcp-form.ts'
import { consoleStateDir, resolveDshHome } from './persist.ts'
import {
  findEntrySpan,
  profilePatchPath,
  readProfilePatch,
  renderPatchEntry,
  upsertPatchEntry,
  writeProfilePatch,
} from './profile-patch.ts'
import { configForm as feishuConfigForm } from '../office-feishu/config-form.ts'

/** 内核 bundle 装卸口（`ctx.pluginManager` 的适配面；缺省 ⇒ dry-run）。 */
export interface ConnectorInstaller {
  installBundle(spec: string): Promise<unknown>
  removeBundle(name: string): Promise<unknown>
}

/** 宿主凭据库的最小写面（`ctx.credentials`；`office-login` 已在用同样的 `set`/`unset`）。 */
export interface CredentialsPort {
  set(ref: string, value: string): Promise<unknown>
  unset(ref: string): Promise<unknown>
}

/** 服务依赖。 */
export interface ConnectorServiceDeps {
  /** Harness home（缺省按内核口径）。 */
  readonly home?: string
  /** 真装/卸口；缺省 ⇒ dry-run。 */
  readonly installer?: ConnectorInstaller
  /** 凭据库写口；缺省 ⇒ secret 字段只能走「明文落 patch」的默认档（详案 §9-11）。 */
  readonly credentials?: CredentialsPort
  /** profile 名（缺省 `desktop`）。 */
  readonly profile?: string
}

/**
 * `create` 的输入：**扁平**——展示信息（slug/name/description）与表单值在同一层
 * （HTTP body 天然就是这个形状，也少一次嵌套）。
 *
 * 三个展示字段标**可选**：HTTP body 是不可信输入，缺失由服务层逐条报人话
 * （`请填写连接器名称` 等），不让类型系统假装它一定在。
 */
export interface ConnectorCreateInput {
  readonly slug?: string
  readonly name?: string
  readonly description?: string
  /** 表单值（`transport` / `serverName` / `command`… 与上面三个同级）。 */
  readonly [key: string]: unknown
}

/** `create` 的结果。 */
export interface ConnectorCreateResult {
  readonly ok: boolean
  readonly slug?: string
  /** dry-run 时为 `true`（落了文件但没真装）。 */
  readonly dryRun?: boolean
  /** 安装口回执（真装时）。 */
  readonly installed?: unknown
  /** 失败原因（人话）。 */
  readonly error?: string
  /** 输入边界问题（字段 label 列表）。 */
  readonly missing?: readonly string[]
}

/** `remove` 的结果。 */
export interface ConnectorRemoveResult {
  readonly ok: boolean
  readonly slug?: string
  readonly dryRun?: boolean
  readonly removed?: boolean
  readonly error?: string
}

/** `configOf` 的返回值：表单 schema + 当前值（敏感已打码）。 */
export interface ConnectorConfigView {
  readonly slug: string
  readonly form: ConfigForm
  readonly values: Record<string, unknown>
  /** 该连接器是否已真装（有 installer 且非 dry-run 时装过）。 */
  readonly installed: boolean
}

/** 本地 bundle 的包名（与 `renderBundlePackageJson` 一致）。 */
function bundleName(slug: string): string {
  return `@local/${slug}`
}

/**
 * `catalog.local.json` 的路径——用 `persist.consoleStateDir` + `LOCAL_CATALOG_FILE` 两个既有
 * 叶子助手拼，**不新造路径知识**（`office-catalog/index.ts` 的 `localCatalogPath()` 是同一路径，
 * 但引它会把整个目录插件壳拖进本插件的 bundle）。
 */
function indexPath(home?: string): string {
  return join(consoleStateDir(home ?? resolveDshHome()), LOCAL_CATALOG_FILE)
}

/**
 * **平台层连接器的表单登记表**：目录条目 id → 插件导出的 `configForm`。
 *
 * 新增一个插件型连接器（飞书 / 钉钉 / 自研渠道）时往这儿加一行——这是**唯一**需要手维护的
 * 清单（MCP 型不需要：它的表单由 `mcpConfigForm()` 按 `spec.transport` 现造）。
 * 写成显式表而不是「自动发现」：自动发现要扫插件目录，而打包运行时里那些目录不一定在场。
 */
const PLUGIN_FORMS: Readonly<Record<string, ConfigForm>> = {
  'connector:feishu': feishuConfigForm,
}

/**
 * 从 profile patch 里读某条目的 config（**只认 4 空格缩进的扁平标量键**）。
 *
 * 插件型连接器的 config 全是扁平标量（飞书：`feishuAppId`/`readOnly`/`baseUrl`）⇒ 够用。
 * 嵌套结构（如 `llm-pi-ai` 的 `providers`）不在支持范围——那些条目不出现在本表的连接器里，
 * 且真要读也该用真 YAML 解析器（仓里零依赖，不做）。
 * @param text - patch 全文。
 * @param id - 条目 id。
 * @returns config 键值；条目不存在 ⇒ `undefined`。
 */
export function readPatchEntryConfig(text: string, id: string): Record<string, unknown> | undefined {
  const span = findEntrySpan(text, id)
  if (span === undefined) return undefined
  const lines = text.split('\n').slice(span.start, span.end)
  const config: Record<string, unknown> = {}
  let inConfig = false
  for (const line of lines) {
    if (/^ {2}config:\s*$/u.test(line)) { inConfig = true; continue }
    if (!inConfig) continue
    // 下一个 2 空格键（`name:` 之类）或新条目 ⇒ config 段结束
    if (/^ {2}\S/u.test(line) && !/^ {4}\S/u.test(line)) break
    const m = /^ {4}(\S+):\s*(.*)$/u.exec(line)
    if (m === null) continue
    const value = (m[2] ?? '').trim()
    if (value === '' || value === "''") { config[m[1] as string] = ''; continue }
    if (value === 'true') { config[m[1] as string] = true; continue }
    if (value === 'false') { config[m[1] as string] = false; continue }
    if (/^-?\d+(\.\d+)?$/u.test(value)) { config[m[1] as string] = Number(value); continue }
    config[m[1] as string] = value.replace(/^'|'$/gu, '').replace(/''/gu, "'")
  }
  return config
}

/** 服务面（路由与测试都照它编程）。 */
export interface ConnectorService {
  create(input: ConnectorCreateInput): Promise<ConnectorCreateResult>
  remove(slug: string): Promise<ConnectorRemoveResult>
  configOf(slug: string): ConnectorConfigView | undefined
  /** 平台层配置（T5b）：写凭据库 + 改 profile patch。 */
  configure(id: string, values: Readonly<Record<string, unknown>>): Promise<ConnectorConfigureResult>
  /** 新建用户自建连接器时的表单（T6）：传输未定 ⇒ 先只给传输选择，选定后再出对应字段。 */
  createForm(transport?: string): { readonly form: ConfigForm; readonly values: Record<string, unknown> }
  list(): readonly ConnectorSpec[]
}

/** `configure`（平台层）的结果。 */
export interface ConnectorConfigureResult {
  readonly ok: boolean
  readonly id?: string
  /** 写进了凭据库的 ref 列表（不含量）。 */
  readonly secretsWritten?: readonly string[]
  /** 是否需要重启才生效（插件启动时读 config）。 */
  readonly restartRequired?: boolean
  readonly error?: string
  readonly missing?: readonly string[]
}

/**
 * 造用户自建连接器服务。
 * @param deps - 依赖（home / installer）。
 */
export function createConnectorService(deps: ConnectorServiceDeps = {}): ConnectorService {
  const root = connectorsRoot(deps.home)

  /** 把索引条目并进 `catalog.local.json`（保序，同 id 覆盖）。 */
  const upsertIndex = (entry: CatalogEntry): void => {
    const path = indexPath(deps.home)
    const current = readLocalCatalog(path).filter((item) => item.id !== entry.id)
    writeLocalCatalog(path, [...current, entry])
  }

  /** 从 `catalog.local.json` 摘掉某条。 */
  const dropIndex = (id: string): void => {
    const path = indexPath(deps.home)
    const current = readLocalCatalog(path)
    if (!current.some((item) => item.id === id)) return
    writeLocalCatalog(path, current.filter((item) => item.id !== id))
  }

  return {
    async create(input) {
      const slug = String(input.slug ?? '').trim()
      // ① slug：作目录名 + npm 包名
      if (!isValidSkillSlug(slug)) {
        return { ok: false, error: `非法连接器 slug：${String(input.slug ?? '')}（小写字母数字开头，只允许 . _ -）` }
      }
      // ② 传输：只认内核那两种
      const transport = typeof input.transport === 'string' ? input.transport.trim() : ''
      if (transport === '') return { ok: false, error: '请选择传输类型' }
      const form = mcpConfigForm(transport)
      // ③ 必填（服务名 / 命令 或 url）
      const missing = missingRequired(form, input)
      if (missing.length > 0) return { ok: false, error: `请填写：${missing.join('、')}`, missing }
      // ④ 服务名：它同时是工具名前缀，限制比 slug 严
      const serverName = typeof input.serverName === 'string' ? input.serverName.trim() : ''
      const problem = serverNameProblem(serverName)
      if (problem !== undefined) return { ok: false, error: problem }
      // ⑤ 展示信息
      const name = String(input.name ?? '').trim()
      const description = String(input.description ?? '').trim()
      if (name === '') return { ok: false, error: '请填写连接器名称' }

      const { config } = splitFormValues(form, input)
      // transport 也进 config（内核 Config 的判别键）；serverName 已单独校验过
      const spec: ConnectorSpec = {
        slug,
        name,
        description,
        serverName,
        transport,
        config: { ...config, transport },
      }
      try {
        writeConnectorBundle(root, spec)
        upsertIndex(localConnectorEntry(spec))
      } catch (error) {
        return { ok: false, error: `写入本地连接器失败：${String((error as Error)?.message ?? error)}` }
      }
      if (deps.installer === undefined) {
        return { ok: true, slug, dryRun: true }
      }
      try {
        const installed = await deps.installer.installBundle(bundleName(slug))
        return { ok: true, slug, dryRun: false, installed }
      } catch (error) {
        // 文件已落、索引已登，只是没装上——把真相说清楚，别报成「创建失败」
        return {
          ok: false,
          slug,
          error: `本地文件已写好，但安装失败：${String((error as Error)?.message ?? error)}`,
        }
      }
    },

    async remove(slug) {
      const clean = slug.trim()
      if (!isValidSkillSlug(clean)) return { ok: false, error: `非法连接器 slug：${slug}` }
      const existed = readConnectorConfig(root, clean) !== undefined
      if (deps.installer === undefined) {
        removeConnectorBundle(root, clean)
        dropIndex(`connector:${clean}`)
        return { ok: true, slug: clean, dryRun: true, removed: existed }
      }
      try {
        await deps.installer.removeBundle(bundleName(clean))
      } catch (error) {
        return { ok: false, slug: clean, error: `卸载失败：${String((error as Error)?.message ?? error)}` }
      }
      removeConnectorBundle(root, clean)
      dropIndex(`connector:${clean}`)
      return { ok: true, slug: clean, dryRun: false, removed: existed }
    },

    configOf(slug) {
      const clean = slug.trim()
      // ① 用户自建层：config.json 是唯一真相（MCP 表单）
      const spec = readConnectorConfig(root, clean)
      if (spec !== undefined) {
        const form = mcpConfigForm(transportOfSpec({ transport: spec.transport }))
        const values: Record<string, unknown> = { ...defaultsOf(form), ...spec.config, serverName: spec.serverName, transport: spec.transport }
        // 敏感键值对打码：只说明「有值」，不回值（防 secret 进界面/日志）
        for (const field of form) {
          if (field.secretValues !== true) continue
          const current = values[field.key]
          if (typeof current === 'object' && current !== null && !Array.isArray(current)) {
            const keys = Object.keys(current as Record<string, unknown>)
            values[field.key] = keys.length === 0 ? {} : Object.fromEntries(keys.map((k) => [k, '••••••••']))
          }
        }
        return { slug: clean, form, values, installed: deps.installer !== undefined }
      }
      // ② 平台层：条目 id（如 `connector:feishu`）→ 插件表单 + patch 里的现值
      const pluginForm = PLUGIN_FORMS[clean]
      if (pluginForm === undefined) return undefined
      const patchText = readProfilePatch(profilePatchPath(deps.home ?? resolveDshHome(), deps.profile))
      const entryId = clean.replace(/^connector:/u, '')
      const current = readPatchEntryConfig(patchText, entryId) ?? {}
      const values: Record<string, unknown> = { ...defaultsOf(pluginForm), ...current }
      // 有凭据库写口 ⇒ secret 走严格档：只说明「已保存」，不回值
      for (const field of pluginForm) {
        if (field.storeAs === undefined || field.storeAs === '') continue
        values[field.key] = deps.credentials !== undefined ? '••••••••' : ''
      }
      return { slug: clean, form: pluginForm, values, installed: true }
    },

    async configure(id, values) {
      const clean = id.trim()
      const form = PLUGIN_FORMS[clean]
      if (form === undefined) {
        return { ok: false, error: `该连接器不支持配置：${id}（当前只有 ${Object.keys(PLUGIN_FORMS).join('、')}）` }
      }
      const missing = missingRequired(form, values)
      if (missing.length > 0) return { ok: false, error: `请填写：${missing.join('、')}`, missing }
      const { config, secrets } = splitFormValues(form, values)
      const entryId = clean.replace(/^connector:/u, '')
      const pluginName = entryId === 'feishu' ? '@office/feishu' : `@office/${entryId}`
      // ① secret 进凭据库（严格档；没有写口才回落明文——见下）
      const written: string[] = []
      if (deps.credentials !== undefined) {
        for (const secret of secrets) {
          try {
            await deps.credentials.set(secret.ref, secret.value)
            written.push(secret.ref)
          } catch (error) {
            return { ok: false, error: `写入凭据库失败（${secret.ref}）：${String((error as Error)?.message ?? error)}` }
          }
        }
      } else if (secrets.length > 0) {
        // 没有凭据库写口：不静默明文落盘，直接说清楚（默认档要有意识地选，不是漏配）
        return {
          ok: false,
          error: '本机未提供凭据库写入口，App Secret 无法安全保存；请改用 JSON 模式写 !!js process.env.<变量名>',
        }
      }
      // ② config 进 profile patch（用户层，覆盖产品默认值）
      try {
        const path = profilePatchPath(deps.home ?? resolveDshHome(), deps.profile)
        const next = upsertPatchEntry(readProfilePatch(path), entryId, renderPatchEntry(entryId, pluginName, config))
        writeProfilePatch(path, next)
      } catch (error) {
        return { ok: false, error: `写入 profile patch 失败：${String((error as Error)?.message ?? error)}` }
      }
      // 插件在启动时读 config ⇒ 必须重启才生效（热重载那条路有未定位缺陷，详案 §5-D3）
      return { ok: true, id: clean, secretsWritten: written, restartRequired: true }
    },

    createForm(transport) {
      // 新建：传输选择永远在（让用户先选），选定后再按传输出其余字段
      const form = mcpConfigForm(transport, { includeTransport: true })
      return { form, values: defaultsOf(form) }
    },

    list() {
      const entries = readLocalCatalog(indexPath(deps.home)).filter((item) => item.kind === 'connector')
      return entries
        .map((entry) => readConnectorConfig(root, entry.id.replace(/^connector:/u, '')))
        .filter((spec): spec is ConnectorSpec => spec !== undefined)
    },
  }
}
