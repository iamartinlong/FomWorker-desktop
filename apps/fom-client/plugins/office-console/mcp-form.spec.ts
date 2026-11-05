/**
 * MCP 通用表单的验收（T3）。字段与内核 `dsh-mcp-client` 的 `Config` 逐键对齐——
 * **加/改内核配置键时同步这里**（详案 §6b 是全表）。
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  MCP_TRANSPORTS,
  isValidServerName,
  mcpConfigForm,
  serverNameProblem,
  transportField,
  transportOfSpec,
} from './mcp-form.ts'
import { defaultsOf, missingRequired, splitFormValues } from './connector-form.ts'

const keysOf = (form: readonly { key: string }[]): string[] => form.map((f) => f.key)

describe('mcp-form · serverName（工具名前缀，限制比 slug 严）', () => {
  it('合法：字母数字 _- ，1–32 字符', () => {
    expect(isValidServerName('github-search')).toBe(true)
    expect(isValidServerName('a')).toBe(true)
    expect(isValidServerName('A_b-9')).toBe(true)
    expect(isValidServerName('a'.repeat(32))).toBe(true)
  })

  it('非法：空 / 超 32 / 中文 / 点 / 空格 / 斜杠', () => {
    expect(isValidServerName('')).toBe(false)
    expect(isValidServerName('a'.repeat(33))).toBe(false)
    expect(isValidServerName('飞书')).toBe(false)
    expect(isValidServerName('a.b')).toBe(false)
    expect(isValidServerName('a b')).toBe(false)
    expect(isValidServerName('a/b')).toBe(false)
  })

  it('serverNameProblem 给出人话（含「它是工具名前缀」这句为什么）', () => {
    expect(serverNameProblem('')).toBe('请填写服务名')
    expect(serverNameProblem('a'.repeat(33))).toBe('服务名最长 32 字符')
    expect(serverNameProblem('飞书')).toContain('mcp__')
    expect(serverNameProblem('ok')).toBeUndefined()
  })
})

describe('mcp-form · 按 transport 显隐', () => {
  it('stdio：命令/参数/环境变量/工作目录，没有 url 与 headers', () => {
    expect(keysOf(mcpConfigForm('stdio'))).toEqual(['serverName', 'command', 'args', 'env', 'cwd', 'toolCallTimeoutMs'])
  })

  it('streamable-http：url/headers，没有命令/参数/工作目录', () => {
    expect(keysOf(mcpConfigForm('streamable-http'))).toEqual(['serverName', 'url', 'headers', 'toolCallTimeoutMs'])
  })

  it('传输未声明：只给通用字段（界面据此提示「未声明传输类型」）', () => {
    expect(keysOf(mcpConfigForm(undefined))).toEqual(['serverName', 'toolCallTimeoutMs'])
    expect(keysOf(mcpConfigForm('sse'))).toEqual(['serverName', 'toolCallTimeoutMs'])
  })

  it('includeTransport：新建时把传输选择放最前面', () => {
    expect(keysOf(mcpConfigForm('stdio', { includeTransport: true }))[0]).toBe('transport')
    expect(transportField().options?.map((o) => o.value)).toEqual([...MCP_TRANSPORTS])
  })

  it('env/headers 标了 secretValues（UI 打码、GET 回落 hasSecret 的依据）', () => {
    const stdio = mcpConfigForm('stdio').find((f) => f.key === 'env')
    const http = mcpConfigForm('streamable-http').find((f) => f.key === 'headers')
    expect(stdio?.secretValues).toBe(true)
    expect(http?.secretValues).toBe(true)
  })

  it('超时缺省 60000，且 hint 明说没有 1000 下限', () => {
    const field = mcpConfigForm('stdio').find((f) => f.key === 'toolCallTimeoutMs')
    expect(field?.default).toBe(String(DEFAULT_TOOL_CALL_TIMEOUT_MS))
    expect(field?.hint).toContain('没有 1000 下限')
  })

  it('transportOfSpec 只认真字符串', () => {
    expect(transportOfSpec({ transport: 'stdio' })).toBe('stdio')
    expect(transportOfSpec({})).toBeUndefined()
    expect(transportOfSpec({ transport: 7 })).toBeUndefined()
    expect(transportOfSpec(undefined)).toBeUndefined()
  })
})

describe('mcp-form · 表单值 → 内核 config', () => {
  it('stdio 一套真值：list 与 keyvalue 都落成内核要的形状', () => {
    const form = mcpConfigForm('stdio')
    const { config } = splitFormValues(form, {
      serverName: 'demo',
      command: 'npx',
      args: ['-y', 'demo-server', ''],
      env: { TOKEN: 'abc', '': 'x', BAD: 7 },
      cwd: 'D:\\tools',
      toolCallTimeoutMs: '30000',
    })
    expect(config).toEqual({
      serverName: 'demo',
      command: 'npx',
      args: ['-y', 'demo-server'],
      env: { TOKEN: 'abc' },
      cwd: 'D:\\tools',
      toolCallTimeoutMs: '30000',
    })
  })

  it('多行文本也能当 list 用（UI 给多行输入框时）', () => {
    const form = mcpConfigForm('stdio')
    const { config } = splitFormValues(form, { serverName: 'd', command: 'npx', args: '-y\n\n demo \n' })
    expect(config.args).toEqual(['-y', 'demo'])
  })

  it('空的可选 list/keyvalue 不落 config（让内核缺省值说话）', () => {
    const form = mcpConfigForm('stdio')
    const { config } = splitFormValues(form, { serverName: 'd', command: 'npx' })
    expect('args' in config).toBe(false)
    expect('env' in config).toBe(false)
    expect('cwd' in config).toBe(false)
    expect('toolCallTimeoutMs' in config).toBe(false)
  })

  it('必填缺失点名中文 label（serverName 与 command）', () => {
    expect(missingRequired(mcpConfigForm('stdio'), {})).toEqual(['服务名', '命令'])
    expect(missingRequired(mcpConfigForm('streamable-http'), {})).toEqual(['服务名', '服务地址'])
  })

  it('defaultsOf 只有超时一个有缺省', () => {
    expect(defaultsOf(mcpConfigForm('stdio'))).toEqual({ toolCallTimeoutMs: '60000' })
  })

  // 反向回归：显隐写反（stdio 给了 url）⇒ 这条必须红
  it('反向：stdio 表单里不该有 url/headers，http 表单里不该有 command', () => {
    expect(keysOf(mcpConfigForm('stdio'))).not.toContain('url')
    expect(keysOf(mcpConfigForm('stdio'))).not.toContain('headers')
    expect(keysOf(mcpConfigForm('streamable-http'))).not.toContain('command')
    expect(keysOf(mcpConfigForm('streamable-http'))).not.toContain('cwd')
  })
})
