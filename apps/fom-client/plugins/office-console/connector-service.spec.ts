/**
 * 用户自建连接器服务的验收（T5a）。安装口用假的——**装卸是不是真发生由这里断言**，
 * 真内核那条路留 T7 的真进程用例（详案 §6.4 明说「装上 ⇒ 工具出现」没端到端跑过）。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createConnectorService, type ConnectorInstaller, type CredentialsPort } from './connector-service.ts'
import { readLocalCatalog } from '../office-catalog/local-catalog.ts'
import { profilePatchPath, readProfilePatch } from './profile-patch.ts'

/** 记录调用的假安装口。 */
function fakeInstaller(): ConnectorInstaller & { readonly installed: string[]; readonly removed: string[] } {
  const installed: string[] = []
  const removed: string[] = []
  return {
    installed,
    removed,
    async installBundle(spec) { installed.push(spec); return { ok: true, spec } },
    async removeBundle(name) { removed.push(name); return { ok: true, name } },
  }
}

const stdioValues = {
  slug: 'github-search',
  name: 'GitHub 检索',
  description: '连一个 GitHub MCP server',
  transport: 'stdio',
  serverName: 'gh',
  command: 'npx',
  args: ['-y', 'demo-server'],
  env: { TOKEN: 'abc' },
}

const httpValues = {
  slug: 'remote-mcp',
  name: '远端 MCP',
  description: '连一个 HTTP MCP',
  transport: 'streamable-http',
  serverName: 'rm',
  url: 'https://example.com/mcp',
  headers: { Authorization: 'Bearer x' },
}

describe('connector-service · create（用户自建层）', () => {
  it('stdio 一套真值 ⇒ 四文件落地 + 索引登记 + 调 installBundle', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fom-csvc-'))
    try {
      const installer = fakeInstaller()
      const svc = createConnectorService({ home, installer })
      const result = await svc.create(stdioValues)
      expect(result).toEqual({ ok: true, slug: 'github-search', dryRun: false, installed: { ok: true, spec: '@local/github-search' } })
      expect(installer.installed).toEqual(['@local/github-search'])
      // 索引条目在场（T1 那条链）
      const index = readLocalCatalog(join(home, 'office', 'catalog.local.json'))
      expect(index.map((item) => item.id)).toEqual(['connector:github-search'])
      expect(index[0]?.origin).toBe('local')
      // 四个文件都在
      for (const rel of ['config.json', 'package.json', 'cordis.patch.yml', 'locale/en.json']) {
        expect(() => readFileSync(join(home, 'office', 'connectors', 'github-search', rel), 'utf8')).not.toThrow()
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('没装安装口 ⇒ dry-run：文件与索引照落，但不调安装', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fom-csvc-'))
    try {
      const svc = createConnectorService({ home })
      const result = await svc.create(httpValues)
      expect(result.ok).toBe(true)
      expect(result.dryRun).toBe(true)
      expect(readLocalCatalog(join(home, 'office', 'catalog.local.json')).length).toBe(1)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('输入边界：slug 非法 / 缺传输 / 必填缺 / 服务名非法 / 缺名称', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fom-csvc-'))
    try {
      const svc = createConnectorService({ home })
      expect(await svc.create({ ...stdioValues, slug: 'Bad Name' })).toMatchObject({ ok: false })
      expect(await svc.create({ ...stdioValues, transport: '' })).toMatchObject({ ok: false, error: '请选择传输类型' })
      const missing = await svc.create({ ...stdioValues, command: '' })
      expect(missing.ok).toBe(false)
      expect(missing.missing).toEqual(['命令'])
      expect(await svc.create({ ...stdioValues, serverName: '飞书' })).toMatchObject({ ok: false })
      expect(await svc.create({ ...stdioValues, name: '  ' })).toMatchObject({ ok: false, error: '请填写连接器名称' })
      // 一个文件都不该落
      expect(readLocalCatalog(join(home, 'office', 'catalog.local.json'))).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('安装口抛 ⇒ 文件已落索引已登，但如实报「没装上」（不假报成功）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fom-csvc-'))
    try {
      const installer = fakeInstaller()
      const failing: ConnectorInstaller = {
        async installBundle() { throw new Error('pnpm add 失败') },
        async removeBundle() { throw new Error('unused') },
      }
      void installer
      const svc = createConnectorService({ home, installer: failing })
      const result = await svc.create(stdioValues)
      expect(result.ok).toBe(false)
      expect(result.error).toContain('本地文件已写好，但安装失败')
      expect(readLocalCatalog(join(home, 'office', 'catalog.local.json')).length).toBe(1)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('同 slug 再建一次 ⇒ 索引不重复（同 id 覆盖）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fom-csvc-'))
    try {
      const svc = createConnectorService({ home })
      await svc.create(stdioValues)
      await svc.create({ ...stdioValues, name: 'GitHub 检索 v2' })
      const index = readLocalCatalog(join(home, 'office', 'catalog.local.json'))
      expect(index.length).toBe(1)
      expect(index[0]?.name).toBe('GitHub 检索 v2')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('connector-service · remove', () => {
  it('删 ⇒ 卸载 + 目录删净 + 索引摘掉', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fom-csvc-'))
    try {
      const installer = fakeInstaller()
      const svc = createConnectorService({ home, installer })
      await svc.create(stdioValues)
      const result = await svc.remove('github-search')
      expect(result).toEqual({ ok: true, slug: 'github-search', dryRun: false, removed: true })
      expect(installer.removed).toEqual(['@local/github-search'])
      expect(readLocalCatalog(join(home, 'office', 'catalog.local.json'))).toEqual([])
      expect(svc.configOf('github-search')).toBeUndefined()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('删不存在的 ⇒ ok + removed:false（幂等）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fom-csvc-'))
    try {
      const installer = fakeInstaller()
      const svc = createConnectorService({ home, installer })
      expect(await svc.remove('nope')).toMatchObject({ ok: true, removed: false })
      expect(installer.removed).toEqual(['@local/nope'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('卸载口抛 ⇒ 目录与索引都不动（别把「卸失败」做成「已删」）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fom-csvc-'))
    try {
      const svc = createConnectorService({ home, installer: { async installBundle() {}, async removeBundle() { throw new Error('in use') } } })
      await svc.create(stdioValues)
      const result = await svc.remove('github-search')
      expect(result.ok).toBe(false)
      expect(result.error).toContain('in use')
      expect(readLocalCatalog(join(home, 'office', 'catalog.local.json')).length).toBe(1)
      expect(svc.configOf('github-search')).toBeDefined()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('connector-service · configOf（GET 的形状与打码）', () => {
  it('按传输给表单，并带回当前值', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fom-csvc-'))
    try {
      const svc = createConnectorService({ home })
      await svc.create(stdioValues)
      const view = svc.configOf('github-search')
      expect(view?.form.map((f) => f.key)).toEqual(['serverName', 'command', 'args', 'env', 'cwd', 'toolCallTimeoutMs'])
      expect(view?.values.serverName).toBe('gh')
      expect(view?.values.command).toBe('npx')
      expect(view?.values.args).toEqual(['-y', 'demo-server'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('敏感键值对打码：只回键名与掩码，不回真值（防 secret 进界面/日志）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fom-csvc-'))
    try {
      const svc = createConnectorService({ home })
      await svc.create(httpValues)
      const view = svc.configOf('remote-mcp')
      expect(view?.values.headers).toEqual({ Authorization: '••••••••' })
      expect(JSON.stringify(view)).not.toContain('Bearer x')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('不存在的 slug ⇒ undefined', () => {
    const home = mkdtempSync(join(tmpdir(), 'fom-csvc-'))
    try {
      expect(createConnectorService({ home }).configOf('nope')).toBeUndefined()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('connector-service · list', () => {
  it('只列连接器，且能读回规格', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fom-csvc-'))
    try {
      const svc = createConnectorService({ home })
      await svc.create(stdioValues)
      await svc.create(httpValues)
      const list = svc.list()
      expect(list.map((s) => s.slug)).toEqual(['github-search', 'remote-mcp'])
      expect(list[0]?.transport).toBe('stdio')
      expect(list[1]?.transport).toBe('streamable-http')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('connector-service · configure（平台层，T5b）', () => {
  const feishuId = 'connector:feishu'

  it('configOf 平台条目 ⇒ 飞书表单 + patch 里的现值；secret 只回掩码', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fom-csvc-'))
    try {
      // 预置一份「用户已经配过」的 patch
      const path = profilePatchPath(home)
      mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true })
      writeFileSync(path, [
        '- id: ui-chat',
        '  config:',
        '    transcriptView: standard',
        '- id: feishu',
        "  name: '@office/feishu'",
        '  config:',
        '    feishuAppId: cli_old',
        '    readOnly: false',
        '',
      ].join('\n'))
      const svc = createConnectorService({ home, credentials: { async set() {}, async unset() {} } })
      const view = svc.configOf(feishuId)
      expect(view?.form.map((f) => f.key)).toEqual(['feishuAppId', 'feishuAppSecret', 'readOnly', 'baseUrl'])
      expect(view?.values.feishuAppId).toBe('cli_old')
      expect(view?.values.readOnly).toBe(false)
      // 有凭据库写口 ⇒ secret 只说明「已保存」；App ID 是标识符不是凭据，现值该回显
      expect(view?.values.feishuAppSecret).toBe('••••••••')
      expect(view?.values.feishuAppId).toBe('cli_old')
      expect(Object.keys(view?.values ?? {}).sort()).toEqual(['baseUrl', 'feishuAppId', 'feishuAppSecret', 'readOnly'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('configure ⇒ secret 进凭据库、config 进 patch、提示重启', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fom-csvc-'))
    try {
      const set: [string, string][] = []
      const credentials: CredentialsPort = {
        async set(ref, value) { set.push([ref, value]) },
        async unset() {},
      }
      const svc = createConnectorService({ home, credentials })
      const result = await svc.configure(feishuId, {
        feishuAppId: 'cli_new', feishuAppSecret: 'topsecret', readOnly: true,
      })
      expect(result).toEqual({ ok: true, id: feishuId, secretsWritten: ['FOM_FEISHU_APP_SECRET'], restartRequired: true })
      expect(set).toEqual([['FOM_FEISHU_APP_SECRET', 'topsecret']])
      const patch = readProfilePatch(profilePatchPath(home))
      expect(patch).toContain('- id: feishu')
      expect(patch).toContain('feishuAppId: cli_new')
      expect(patch).toContain('readOnly: true')
      // secret 绝不进 patch
      expect(patch).not.toContain('topsecret')
      expect(patch).not.toContain('feishuAppSecret')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('再配一次 ⇒ 覆盖同 id 条目，不新增、别人的条目不动', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fom-csvc-'))
    try {
      mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true })
      writeFileSync(profilePatchPath(home), '- id: ui-chat\n  config:\n    a: b\n')
      const svc = createConnectorService({ home, credentials: { async set() {}, async unset() {} } })
      await svc.configure(feishuId, { feishuAppId: 'cli_1', feishuAppSecret: 's1' })
      await svc.configure(feishuId, { feishuAppId: 'cli_2', feishuAppSecret: 's2' })
      const patch = readProfilePatch(profilePatchPath(home))
      expect(patch.match(/- id: feishu/gu)?.length).toBe(1)
      expect(patch).toContain('feishuAppId: cli_2')
      expect(patch).not.toContain('cli_1')
      expect(patch).toContain('- id: ui-chat')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('没有凭据库写口 ⇒ 明确拒绝，不静默明文落盘', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fom-csvc-'))
    try {
      const svc = createConnectorService({ home })
      const result = await svc.configure(feishuId, { feishuAppId: 'cli_x', feishuAppSecret: 's' })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('无法安全保存')
      // 一个文件都不该落
      expect(readProfilePatch(profilePatchPath(home))).toBe('')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('必填缺失 ⇒ 400 形状的 missing，且不写任何东西', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fom-csvc-'))
    try {
      const svc = createConnectorService({ home, credentials: { async set() {}, async unset() {} } })
      const result = await svc.configure(feishuId, { feishuAppSecret: 's' })
      expect(result.ok).toBe(false)
      expect(result.missing).toEqual(['App ID'])
      expect(readProfilePatch(profilePatchPath(home))).toBe('')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('不支持的 id ⇒ 明确说不支持（不假装能配）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fom-csvc-'))
    try {
      const svc = createConnectorService({ home })
      const result = await svc.configure('connector:wecom', { a: 'b' })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('不支持配置')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
