/**
 * 用户自建 MCP 连接器落地的验收（T4）。形状对照内核自带模板
 * （`dsh-agent-preset/skills/cordis-plugin-development/templates/mcp/`，详案 §6.1）。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MCP_CLIENT_PLUGIN,
  connectorsRoot,
  isValidConnectorSlug,
  localConnectorEntry,
  readConnectorConfig,
  removeConnectorBundle,
  renderBundlePackageJson,
  renderBundlePatch,
  writeConnectorBundle,
  type ConnectorSpec,
} from './connector-bundle.ts'
import { parseLocalCatalog } from '../office-catalog/local-catalog.ts'

const stdioSpec: ConnectorSpec = {
  slug: 'github-search',
  name: 'GitHub 检索',
  description: '连一个 GitHub MCP server',
  serverName: 'gh',
  transport: 'stdio',
  config: { command: 'npx', args: ['-y', 'demo-server'], env: { TOKEN: 'abc' }, cwd: 'D:\\tools', toolCallTimeoutMs: '30000' },
}

const httpSpec: ConnectorSpec = {
  slug: 'remote-mcp',
  name: '远端 MCP',
  description: '连一个 HTTP MCP',
  serverName: 'rm',
  transport: 'streamable-http',
  config: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
}

describe('connector-bundle · 生成的 patch 形状（照内核模板）', () => {
  it('stdio：insert 一条 dsh-mcp-client，config 含内核全部键；数字键落成裸数字', () => {
    const yaml = renderBundlePatch(stdioSpec)
    expect(yaml).toContain('- insert:')
    expect(yaml).toContain(`name: '${MCP_CLIENT_PLUGIN}'`)
    expect(yaml).toContain('serverName: gh')
    expect(yaml).toContain('transport: stdio')
    expect(yaml).toContain('command: npx')
    expect(yaml).toContain('args: [')
    expect(yaml).toContain('env: {')
    expect(yaml).toContain('toolCallTimeoutMs: 30000')   // 数字，不是 '30000'
    expect(yaml).not.toContain('toolCallTimeoutMs: \'')
  })

  it('streamable-http：url 与 headers，没有 command/args/cwd', () => {
    const yaml = renderBundlePatch(httpSpec)
    expect(yaml).toContain('transport: streamable-http')
    expect(yaml).toContain('url: https://example.com/mcp')
    expect(yaml).toContain('headers: {')
    expect(yaml).not.toContain('command:')
  })

  it('含特殊字符的值才被引号包住（URL 的冒号不用引、`冒号+空格`才要）', () => {
    const yaml = renderBundlePatch({
      ...httpSpec,
      config: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer a b', 'X-Odd': 'has: colon' } },
    })
    expect(yaml).toContain('url: https://example.com/mcp')   // 冒号不在末尾、后面没空格 ⇒ 裸标量合法
    expect(yaml).toContain("'has: colon'")                    // 冒号+空格 ⇒ 必须引
    expect(yaml).toContain('Bearer a b')                      // 流上下文里带空格合法，不必引
  })

  it('package.json 有 dsh.bundle.patch 与 locale exports（缺了 installBundle 会抛 not-bundle）', () => {
    const pkg = JSON.parse(renderBundlePackageJson('github-search'))
    expect(pkg.name).toBe('@local/github-search')
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(pkg.exports['./locale/*.json']).toBe('./locale/*.json')
    expect(pkg.files).toContain('cordis.patch.yml')
  })
})

describe('connector-bundle · 落地四文件与读回', () => {
  it('write ⇒ 四个文件都在，config.json 是唯一真相且能原样读回', () => {
    const root = mkdtempSync(join(tmpdir(), 'fom-conn-'))
    try {
      const { dir, config, patch } = writeConnectorBundle(root, stdioSpec)
      expect(config).toBe(join(dir, 'config.json'))
      expect(patch).toBe(join(dir, 'cordis.patch.yml'))
      for (const rel of ['config.json', 'package.json', 'cordis.patch.yml', 'locale/en.json']) {
        expect(() => readFileSync(join(dir, rel), 'utf8')).not.toThrow()
      }
      const back = readConnectorConfig(root, 'github-search')
      expect(back).toEqual(stdioSpec)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('remove ⇒ 整目录没了；再删返回 false', () => {
    const root = mkdtempSync(join(tmpdir(), 'fom-conn-'))
    try {
      writeConnectorBundle(root, stdioSpec)
      expect(removeConnectorBundle(root, 'github-search')).toBe(true)
      expect(removeConnectorBundle(root, 'github-search')).toBe(false)
      expect(readConnectorConfig(root, 'github-search')).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('坏 config.json / 不存在的 slug ⇒ 读回 undefined（不抛）', () => {
    const root = mkdtempSync(join(tmpdir(), 'fom-conn-'))
    try {
      const dir = join(root, 'broken')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'config.json'), '{ not json')
      expect(readConnectorConfig(root, 'broken')).toBeUndefined()
      expect(readConnectorConfig(root, 'nope')).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('非法 slug / 不认识的传输 ⇒ 抛，且一个文件都不写', () => {
    const root = mkdtempSync(join(tmpdir(), 'fom-conn-'))
    try {
      expect(() => writeConnectorBundle(root, { ...stdioSpec, slug: 'Bad Name' })).toThrow(/非法连接器 slug/)
      expect(() => writeConnectorBundle(root, { ...stdioSpec, transport: 'sse' })).toThrow(/不支持的传输类型/)
      expect(existsSync(join(root, 'Bad Name'))).toBe(false)
      expect(existsSync(join(root, 'github-search'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('connector-bundle · 索引条目与 slug', () => {
  it('索引条目：kind=connector、source.kind=mcp、spec 带 transport（T1 的输入源）', () => {
    const entry = localConnectorEntry(stdioSpec)
    expect(entry.id).toBe('connector:github-search')
    expect(entry.kind).toBe('connector')
    expect(entry.origin).toBe('local')
    expect(entry.source).toEqual({ kind: 'mcp', ref: 'github-search' })
    expect(entry.spec).toEqual({ transport: 'stdio', serverName: 'gh' })
  })

  it('索引条目能穿过本地目录文件的 parse（T1 那条链）', () => {
    const parsed = parseLocalCatalog({ schemaVersion: 1, entries: [localConnectorEntry(stdioSpec)] })
    expect(parsed.problems).toEqual([])
    expect(parsed.entries[0]?.spec).toEqual({ transport: 'stdio', serverName: 'gh' })
  })

  it('slug 判据复用技能那条（作目录名 + npm 包名）', () => {
    expect(isValidConnectorSlug('github-search')).toBe(true)
    expect(isValidConnectorSlug('Bad Name')).toBe(false)
    expect(isValidConnectorSlug('飞书')).toBe(false)
  })

  it('connectorsRoot：DSH_HOME 优先，否则 ~/.dsh', () => {
    const prev = process.env.DSH_HOME
    try {
      process.env.DSH_HOME = 'D:\\dsh-test'
      expect(connectorsRoot()).toBe(join('D:\\dsh-test', 'office', 'connectors'))
      delete process.env.DSH_HOME
      expect(connectorsRoot()).toContain(join('office', 'connectors'))
      expect(connectorsRoot('D:\\x')).toBe(join('D:\\x', 'office', 'connectors'))
    } finally {
      if (prev !== undefined) process.env.DSH_HOME = prev
    }
  })
})
