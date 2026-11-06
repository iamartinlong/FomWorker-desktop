/**
 * **MCP 连接器的通用配置表单**（T3）：按内核 `@deepseek-ai/dsh-mcp-client` 的 `Config`
 * 逐键生成。字段的唯一权威＝那个 `z.union`（装机版 asar 里可读，详案 §6b 有全表）。
 *
 * 两条硬事实（别凭参照图想象）：
 * 1. **传输只有 `stdio` / `streamable-http` 两种**——没有 `http`、没有 `sse`
 *    （用户参照的 Qoder 对话框是三种，不照抄）；
 * 2. **工具名是 `mcp__<serverName>__<rawName>`**，命名空间化 ⇒ 两个 MCP 只要
 *    `serverName` 不同就不撞名（方案 §5.3 的撞名三选一在这条路上不需要选）。
 *
 * 与「插件型」的分工：插件型（飞书）由插件自己导出表单（`configForm`），
 * MCP 型没有宿主插件可导出，所以由本模块按 `transport` 现造。
 */

import type { ConfigForm, ConfigFormField } from './connector-form.ts'

/** 内核 `dsh-mcp-client` 的 `serverName` pattern（`^[A-Za-z0-9_-]{1,32}$`）。 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** 内核认的两种传输（`z.const`）。 */
export const MCP_TRANSPORTS = ['stdio', 'streamable-http'] as const

export type McpTransport = (typeof MCP_TRANSPORTS)[number]

/** 内核 `toolCallTimeoutMs` 的缺省值（60_000）。 */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000

/**
 * `serverName` 合法性（它同时是工具名前缀，故限制比 slug 严）。
 * @param name - 待校验的服务名。
 * @returns 合法为 `true`。
 */
export function isValidServerName(name: string): boolean {
  return SERVER_NAME_PATTERN.test(name)
}

/** `serverName` 不合法时的一句人话（输入边界报错用）。 */
export function serverNameProblem(name: string): string | undefined {
  if (name === '') return '请填写服务名'
  if (name.length > 32) return '服务名最长 32 字符'
  if (!isValidServerName(name)) return '服务名只能用字母、数字、下划线与连字符（它是工具名前缀 mcp__<服务名>__<工具>）'
  return undefined
}

/** 传输类型字段（新建时让用户选；平台下发的条目传输只读，由界面不给这个字段）。 */
export function transportField(): ConfigFormField {
  return {
    key: 'transport',
    label: '传输类型',
    type: 'select',
    required: true,
    options: [
      { value: 'stdio', label: 'stdio（本地命令）' },
      { value: 'streamable-http', label: 'streamable-http（HTTP 服务）' },
    ],
    hint: '决定后面出现哪些字段；平台下发的连接器按目录声明，不可改',
  }
}

/** 单次调用超时字段（两种传输都有）。 */
function timeoutField(): ConfigFormField {
  return {
    key: 'toolCallTimeoutMs',
    label: '单次调用超时（毫秒，可选）',
    type: 'text',
    default: String(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    hint: '留空用默认 60000；没有 1000 下限（那是别的产品的规则）',
  }
}

/** 服务名字段（两种传输都有）。 */
function serverNameField(required: boolean): ConfigFormField {
  return {
    key: 'serverName',
    label: '服务名',
    type: 'text',
    required,
    placeholder: 'github-search',
    hint: '只能用字母数字 _- ，最长 32；它决定工具名前缀 mcp__<服务名>__<工具>，同机不可重名',
  }
}

/**
 * 按传输类型生成 MCP 表单（平台层与用户层共用）。
 *
 * @param transport - 传输类型；`undefined`／不认 ⇒ 只给通用字段 + 一句提示
 *   （界面据此告诉用户「该连接器未声明传输类型」）。
 * @param options - `includeTransport`：是否带上「传输类型」字段（新建时要，配置已装的不给）。
 * @returns 表单（字段顺序即展示顺序）。
 */
export function mcpConfigForm(transport: string | undefined, options: { readonly includeTransport?: boolean } = {}): ConfigForm {
  const fields: ConfigFormField[] = []
  if (options.includeTransport === true) fields.push(transportField())
  fields.push(serverNameField(true))
  if (transport === 'stdio') {
    fields.push({
      key: 'command',
      label: '命令',
      type: 'text',
      required: true,
      placeholder: 'npx',
      hint: '启动 MCP server 的可执行文件，例如 npx / python / node',
    })
    fields.push({
      key: 'args',
      label: '参数（每行一个）',
      type: 'list',
      hint: '例如 -y 与 @modelcontextprotocol/server-everything 各占一行',
    })
    fields.push({
      key: 'env',
      label: '环境变量',
      type: 'keyvalue',
      secretValues: true,
      hint: '键值对；值会写进本机 patch 文件，敏感值请改用 JSON 模式写 !!js process.env.<变量名>',
    })
    fields.push({
      key: 'cwd',
      label: '工作目录（可选）',
      type: 'text',
      placeholder: 'D:\\tools\\my-mcp',
      hint: '只接受绝对路径；留空用当前工作目录',
    })
    fields.push(timeoutField())
    return fields
  }
  if (transport === 'streamable-http') {
    fields.push({
      key: 'url',
      label: '服务地址',
      type: 'text',
      required: true,
      placeholder: 'https://example.com/mcp',
      hint: '支持 HTTP 或 HTTPS；不要在 URL 中放 token 或密码',
    })
    fields.push({
      key: 'headers',
      label: '请求头',
      type: 'keyvalue',
      secretValues: true,
      hint: '键值对；值会写进本机 patch 文件，敏感值请改用 JSON 模式写 !!js process.env.<变量名>',
    })
    fields.push(timeoutField())
    return fields
  }
  // 传输未知／未声明：只给通用字段，界面据此提示
  fields.push(timeoutField())
  return fields
}

/**
 * 从目录条目的 `spec` 里取传输类型（`spec.transport`，字符串）。
 * @param spec - 条目 spec（可为空）。
 * @returns 传输类型或 `undefined`。
 */
export function transportOfSpec(spec: Record<string, unknown> | undefined): string | undefined {
  const value = spec?.transport
  return typeof value === 'string' && value !== '' ? value : undefined
}
