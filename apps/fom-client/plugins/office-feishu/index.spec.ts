/**
 * `office-feishu` 装配形态 + App Secret 落点的验收单测（不起 cordis、不发网络）：
 * 休眠 / 半配置响亮抛 / **凭据库优先、env 兜底** / readOnly / 写工具结构互锁。
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, OfficeFeishu, readAppSecret, type OfficeFeishuConfig } from './index.ts'

const ENV = 'FEISHU_APP_SECRET_TEST'
const REF = 'FOM_FEISHU_APP_SECRET_TEST'

interface FakeCtx {
  ctx: Context
  registered: string[]
  logs: string[]
  stderr: string[]
}

/**
 * 只给 `apply` 用到的几面：`tools.register`（收名字）、`logger`、`get('credentials')`、
 * `inject`（`gate: true` 时才让 `officeRiskGate` 出现）、`effect`。
 */
function fakeCtx(options: { gate?: boolean; storedSecret?: string } = {}): FakeCtx {
  const registered: string[] = []
  const logs: string[] = []
  const stderr: string[] = []
  const ctx = {
    tools: { register: (tool: { name: string }) => { registered.push(tool.name); return () => {} } },
    logger: () => ({ info: (m: string) => { logs.push(m) }, warn: (m: string) => { logs.push(m) } }),
    get: (key: string) => key === 'credentials'
      ? { resolve: async (ref: string) => ref === REF && options.storedSecret !== undefined ? { value: options.storedSecret } : undefined }
      : undefined,
    inject: (deps: readonly string[], callback: (scoped: unknown) => void) => {
      if (deps.includes('officeRiskGate') && options.gate === true) {
        callback({ effect: (setup: () => () => void) => setup() })
      }
      return () => {}
    },
    effect: (setup: () => (() => void) | void) => setup(),
  }
  return { ctx: ctx as unknown as Context, registered, logs, stderr }
}

const base: OfficeFeishuConfig = {
  feishuAppId: '',
  feishuAppSecretRef: REF,
  feishuAppSecretEnv: ENV,
  baseUrl: 'https://open.feishu.cn',
  readOnly: false,
}

const READS = ['feishu_doc_read', 'feishu_bitable_list_records', 'feishu_calendar_list_events']
const WRITES = ['feishu_doc_create', 'feishu_bitable_create_record', 'feishu_calendar_create_event']

afterEach(() => {
  delete process.env[ENV]
})

describe('App Secret 落点（凭据库优先、env 兜底）', () => {
  it('凭据库有值 ⇒ 用它（即使 env 也设了）', async () => {
    process.env[ENV] = 'from-env'
    const fake = fakeCtx({ storedSecret: 'from-store' })
    await expect(readAppSecret(fake.ctx, base)).resolves.toEqual({ value: 'from-store', source: 'credentials' })
  })

  it('凭据库空/取不到 ⇒ 用 env', async () => {
    process.env[ENV] = 'from-env'
    const fake = fakeCtx()
    await expect(readAppSecret(fake.ctx, base)).resolves.toEqual({ value: 'from-env', source: 'env' })
  })

  it('两处都空 ⇒ none；ref 配空则跳过凭据库', async () => {
    const empty = fakeCtx()
    await expect(readAppSecret(empty.ctx, base)).resolves.toEqual({ value: '', source: 'none' })
    // ref 配空 ⇒ 即便凭据库里有值也不去取（只走 env）。
    const stored = fakeCtx({ storedSecret: 'from-store' })
    await expect(readAppSecret(stored.ctx, { ...base, feishuAppSecretRef: '' }))
      .resolves.toEqual({ value: '', source: 'none' })
  })
})

describe('office-feishu 装配形态', () => {
  it('插件声明 inject 含 credentials ⇒ 装配晚于凭据库就绪（否则 apply 期解析会落回 env）', () => {
  expect(OfficeFeishu.inject).toEqual(['tools', 'credentials'])
  })

  it('未配 appId ⇒ 休眠：不抛、零注册', async () => {
    const fake = fakeCtx({ gate: true, storedSecret: 's' })
    const release = await apply(fake.ctx, base)
    expect(fake.registered).toEqual([])
    expect(fake.logs.join('\n')).toContain('休眠')
    release()
  })

  it('配了 appId 但两处都没有 Secret ⇒ 响亮抛，且**点名两个落点**', async () => {
    const fake = fakeCtx({ gate: true })
    await expect(apply(fake.ctx, { ...base, feishuAppId: 'cli_test' }))
      .rejects.toThrow(new RegExp(`${REF}.*${ENV}`))
  })

  it('凭据库有 Secret ⇒ 正常装配（日志报来源 credentials）', async () => {
    const fake = fakeCtx({ gate: true, storedSecret: 'from-store' })
    const release = await apply(fake.ctx, { ...base, feishuAppId: 'cli_test', readOnly: true })
    expect(fake.registered).toEqual(READS)
    expect(fake.logs.join('\n')).toContain('credentials')
    release()
  })

  it('readOnly ⇒ 只注册 3 个读工具（L0）', async () => {
    const fake = fakeCtx({ gate: true, storedSecret: 's' })
    const release = await apply(fake.ctx, { ...base, feishuAppId: 'cli_test', readOnly: true })
    expect(fake.registered).toEqual(READS)
    release()
  })

  it('readOnly=false 且闸在 ⇒ 读 3 + 写 3', async () => {
    const fake = fakeCtx({ gate: true, storedSecret: 's' })
    await apply(fake.ctx, { ...base, feishuAppId: 'cli_test' })
    expect(fake.registered).toEqual([...READS, ...WRITES])
  })

  it('readOnly=false 但闸不在 ⇒ 写工具不注册（fail-closed）', async () => {
    const fake = fakeCtx({ gate: false, storedSecret: 's' })
    await apply(fake.ctx, { ...base, feishuAppId: 'cli_test' })
    expect(fake.registered).toEqual(READS)
    expect(fake.logs.join('\n')).toContain('fail-closed')
  })
})
