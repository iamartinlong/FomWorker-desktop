/**
 * **连接器配置表单**的纯类型与纯函数（无 cordis、无 fs、无 React）——控制台消费、
 * 各连接器自己声明。与 `catalog-view.ts` 同一定位：抽出来只为可单测。
 *
 * 两类连接器、两种表单来源（《详细实施-连接器配置表单v0.1》§4.2）：
 * - **插件型**（如飞书）：由插件叶子模块导出 `ConfigForm`（见 `office-feishu/config-form.ts`）；
 * - **MCP 型**：由 `mcp-form.ts` 按 `spec.transport` 现造（T3）。
 *
 * **关键约定：表单键 ≠ 配置键。** `storeAs` 字段的值走**宿主凭据库**、不进 config；
 * 其余字段的值按键名写进插件 config。这条分流由 `splitFormValues()` 一处收口。
 */

/** 字段类型：文本 / 密钥 / 布尔 / 字符串列表 / 键值对 / 单选。 */
export type ConfigFormFieldType = 'text' | 'secret' | 'boolean' | 'list' | 'keyvalue' | 'select'

/** `select` 字段的一个选项。 */
export interface ConfigFormOption {
  readonly value: string
  readonly label: string
}

/** 一个表单字段。 */
export interface ConfigFormField {
  /** 表单键（非 `storeAs` 时＝插件 config 的键名）。 */
  readonly key: string
  /** 展示名（中文）。 */
  readonly label: string
  readonly type: ConfigFormFieldType
  /** 必填；缺失时 `missingRequired()` 点名它。 */
  readonly required?: boolean
  readonly placeholder?: string
  /** 怎么填 / 为什么（面向用户的人因文案）。 */
  readonly hint?: string
  /** 缺省值（`defaultsOf()` 用）。 */
  readonly default?: unknown
  /** `select` 专用：选项（值 → 展示名）。 */
  readonly options?: readonly ConfigFormOption[]
  /**
   * **secret 专用**：值写进宿主凭据库时用的 ref 名。设了即表示「这个字段的值不进 config」。
   * 端点据此分流（`splitFormValues()`）。
   */
  readonly storeAs?: string
  /**
   * **`keyvalue` 专用**：值为敏感 ⇒ UI 打码、`GET` 回落 `hasSecret`。
   * ⚠️ 默认档下值仍会写进生成的 patch 文件（内核 `env`/`headers` 是 `Record<string,string>`、
   * 没有凭据引用语法，见详案 §9-11）；要更严用 JSON 模式写 `!!js process.env.X`。
   */
  readonly secretValues?: boolean
}

/** 一份表单（只读数组；连接器导出的就是它）。 */
export type ConfigForm = readonly ConfigFormField[]

/** `splitFormValues()` 的结果：该进 config 的 + 该进凭据库的。 */
export interface SplitFormValues {
  readonly config: Record<string, unknown>
  readonly secrets: readonly { readonly ref: string; readonly value: string }[]
}

/**
 * 表单缺省值（只取声明了 `default` 的字段）。
 * @param form - 表单。
 * @returns 键 → 缺省值。
 */
export function defaultsOf(form: ConfigForm): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of form) {
    if (field.default !== undefined) out[field.key] = field.default
  }
  return out
}

/** 值算不算「空」（必填校验用）：字符串空白算空、空数组/空对象算空。 */
function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length === 0
  return false
}

/**
 * 必填缺失的字段 label（输入边界校验用）。
 *
 * **布尔与 `select` 永不参与**：没勾／没选都有确定的合法值（`false`／空串），
 * 报「请填写」是错的 UX。
 * @param form - 表单。
 * @param values - 用户填的值（缺省按空）。
 * @returns 缺失字段的 label 列表（保序）。
 */
export function missingRequired(form: ConfigForm, values: Readonly<Record<string, unknown>>): string[] {
  const out: string[] = []
  for (const field of form) {
    if (field.required !== true || field.type === 'boolean' || field.type === 'select') continue
    if (isEmptyValue(values[field.key])) out.push(field.label)
  }
  return out
}

/** 表单里声明了 `storeAs` 的 secret 字段（端点要给它们写凭据库）。 */
export function secretRefsOf(form: ConfigForm): readonly { readonly key: string; readonly ref: string }[] {
  return form.filter((f) => f.storeAs !== undefined && f.storeAs !== '')
    .map((f) => ({ key: f.key, ref: f.storeAs as string }))
}

/**
 * 把表单值分成「进 config」与「进凭据库」两拨（本模块的核心分流）。
 *
 * 规则按字段类型：
 * - `storeAs` 字段 ⇒ `secrets`（值 + ref）；**空值不写**（保留库里原有的，别用空值擦了）
 * - `boolean` ⇒ 一律成布尔（没勾就是 `false`，否则「取消勾选」永远存不下去）
 * - `select` ⇒ 字符串原样（空串＝没选，让下游默认值说话）
 * - `list` ⇒ `string[]`（吃数组，或把多行文本按行拆；剔空白行）
 * - `keyvalue` ⇒ `Record<string,string>`（吃对象；键或值非字符串的项丢掉；空键丢掉）
 * - `text` / `secret`（无 `storeAs`）⇒ 去首尾空白的字符串；
 *   **空的可选文本不写**（让插件的 zod 缺省值说话），必填的即使为空也写（让下游去报）
 *
 * @param form - 表单。
 * @param values - 用户填的值。
 * @returns 分流结果。
 */
export function splitFormValues(form: ConfigForm, values: Readonly<Record<string, unknown>>): SplitFormValues {
  const config: Record<string, unknown> = {}
  const secrets: { ref: string; value: string }[] = []
  for (const field of form) {
    const raw = values[field.key]
    if (field.type === 'boolean') {
      config[field.key] = raw === true
      continue
    }
    if (field.type === 'list') {
      const items = Array.isArray(raw)
        ? raw.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter((item) => item !== '')
        : typeof raw === 'string' ? raw.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '') : []
      if (items.length > 0 || field.required === true) config[field.key] = items
      continue
    }
    if (field.type === 'keyvalue') {
      const pairs: Record<string, string> = {}
      if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
          if (key.trim() === '') continue
          if (typeof value !== 'string') continue
          pairs[key.trim()] = value.trim()
        }
      }
      if (Object.keys(pairs).length > 0 || field.required === true) config[field.key] = pairs
      continue
    }
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (field.storeAs !== undefined && field.storeAs !== '') {
      // 空 secret 不写凭据库（保留库里原有的，别用空值把它擦了）
      if (text !== '') secrets.push({ ref: field.storeAs, value: text })
      continue
    }
    if (text === '' && field.required !== true && field.type !== 'select') continue
    config[field.key] = text
  }
  return { config, secrets }
}
