/**
 * M1 台账实现的验收单测（设计 §8 第 1 步）：E3 重启、E4 重复点击、E12 写失败必须拒，
 * 外加 §3.4.1 由 U1 实测钉死的 digest 规则与 E9/E10 的授权消费语义。
 *
 * 后端一律用真实的 `storage-json`：台账的价值就是「写失败能被感知 + 重启还在」，
 * 用内存 Map 假这两件事都测不到。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { argsDigest, approvalLedgerDomain, ApprovalLedger } from './ledger.ts'
import type { ApprovalRequestRecord } from './ledger.ts'

async function newRoot() {
  const root = await mkdtemp(join(tmpdir(), 'office-ledger-'))
  roots.push(root)
  return root
}
const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** 装出与产品 patch 相同的存储栈：hub + json 后端 + domain 形式，然后开台账域。 */
async function boot(root: string, backend?: StorageBackend) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  if (backend === undefined) {
    await ctx.plugin(StorageJson, { root })
  } else {
    ctx.storage.backend.register('json', backend)
    ctx.provide(storageBackendServiceKey('json'), backend)
  }
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const domain = await ctx.storageDomain.open(approvalLedgerDomain)
  return { ctx, domain, ledger: new ApprovalLedger(domain) }
}

/** 让指定表的整记录写入失败的后端包装 —— E12 靠它，而不是靠改内核代码。 */
function rejectingBackend(root: string, table: string): StorageBackend {
  const base = new JsonStorageBackend(root)
  const fail = () => Promise.reject(new Error('simulated disk failure'))
  return {
    close: () => base.close(),
    kv: {
      open: async (descriptor: KvUnitDescriptor): Promise<KvUnit> => {
        const unit = await (base.kv.open(descriptor) as Promise<KvUnit>)
        return {
          loadAll: () => unit.loadAll(),
          putRecord: (target, key, value) => (target === table ? fail() : unit.putRecord(target, key, value)),
          deleteRecord: (target, key) => unit.deleteRecord(target, key),
          setGlobal: value => unit.setGlobal(value),
          close: () => unit.close(),
        }
      },
    },
  }
}

function requestFixture(overrides: Partial<ApprovalRequestRecord> = {}): ApprovalRequestRecord {
  return {
    requestId: 'req-1',
    sessionId: 'session-1',
    tenantId: 'tenant-1',
    toolName: 'write',
    riskLevel: 'L3',
    actionSummary: '写入 C:\\Users\\demo\\report.docx',
    toolArgs: { file_path: 'C:\\Users\\demo\\report.docx', content: 'hello' },
    displayReason: '目标文件在会话工作区之外，需要超出 workspace-write 的访问权限',
    status: 'pending',
    askedAt: 1_000,
    windowEndsAt: 90_000,
    expiresAt: 86_401_000,
    decidedBy: null,
    decidedAt: null,
    ...overrides,
  }
}

const escalated = {
  file_path: 'C:\\Users\\demo\\report.docx',
  content: 'hello',
  sandbox_permissions: 'danger-full-access',
}

describe('台账：状态迁移 CAS', () => {
  it('E4 同一 requestId 并发点两次，只有第一次赢，且只落一条授权', async () => {
    const { ledger } = await boot(await newRoot())
    await ledger.create(requestFixture())
    const results = await Promise.all([
      ledger.approve('req-1', { decidedBy: 'ou-alice', now: 2_000, grant: { grantId: 'g-1', toolName: 'write', argsDigest: argsDigest(escalated), grantExpiresAt: 3_000 } }),
      ledger.approve('req-1', { decidedBy: 'ou-bob', now: 2_001, grant: { grantId: 'g-2', toolName: 'write', argsDigest: argsDigest(escalated), grantExpiresAt: 3_000 } }),
    ])
    expect(results.map(result => result.won)).toEqual([true, false])
    const record = ledger.get('req-1')!
    expect(record.status).toBe('approved')
    expect(record.decidedBy).toBe('ou-alice')
    expect([...ledger.grants.keys()]).toEqual(['g-1'])
  })

  it('hasOutstandingGrant：批件落账即为真，收回或消费掉即转假（§3.5 作废只认有没有批件）', async () => {
    const { ledger } = await boot(await newRoot())
    await ledger.create(requestFixture())
    // 批准之前没有批件。
    expect(ledger.hasOutstandingGrant('req-1')).toBe(false)
    const digest = argsDigest(escalated)
    await ledger.approve('req-1', { decidedBy: 'ou-alice', now: 2_000, grant: { grantId: 'g-1', toolName: 'write', argsDigest: digest, grantExpiresAt: 3_000 } })
    // 批准落了批件。
    expect(ledger.hasOutstandingGrant('req-1')).toBe(true)
    // 重放消费掉批件（一次性的用完即删）—— 这条 approved 记录不再有东西要收回。
    await ledger.consumeGrant('write', digest, 2_500)
    expect(ledger.hasOutstandingGrant('req-1')).toBe(false)
    // 别的 requestId 不受牵连。
    expect(ledger.hasOutstandingGrant('req-nope')).toBe(false)
  })

  it('窗口已过（expired）仍允许延迟批准，rejected 是终态', async () => {
    const { ledger } = await boot(await newRoot())
    await ledger.create(requestFixture({ status: 'expired' }))
    expect(await ledger.transition('req-1', { from: ['pending', 'expired', 'recalled'], to: 'approved' })).toBe(true)
    await ledger.create(requestFixture({ requestId: 'req-2', status: 'rejected' }))
    expect(await ledger.transition('req-2', { from: ['pending', 'expired', 'recalled'], to: 'approved' })).toBe(false)
    expect(ledger.get('req-2')!.status).toBe('rejected')
  })
})

describe('台账：E3 进程重启', () => {
  it('域关闭后重开，pending 仍在并可被裁决；授权同样活过重启', async () => {
    const root = await newRoot()
    const first = await boot(root)
    await first.ledger.create(requestFixture())
    await first.ctx.fiber.dispose()

    const second = await boot(root)
    expect(second.ledger.get('req-1')!.status).toBe('pending')
    const digest = argsDigest(escalated)
    const result = await second.ledger.approve('req-1', {
      decidedBy: 'ou-alice', now: 5_000,
      grant: { grantId: 'g-1', toolName: 'write', argsDigest: digest, grantExpiresAt: 9_000 },
    })
    expect(result.won).toBe(true)
    await second.ctx.fiber.dispose()

    // 冷会话醒来后发起的重放，是在第三个进程里消费授权的
    const third = await boot(root)
    expect(await third.ledger.consumeGrant('write', digest, 6_000)).toBeDefined()
    expect([...third.ledger.grants.keys()]).toEqual([])
  })
})

describe('台账：E12 写失败', () => {
  it('落不下 pending 就 reject，且内存里不留半个状态', async () => {
    const root = await newRoot()
    const { ledger } = await boot(root, rejectingBackend(root, 'requests'))
    await expect(ledger.create(requestFixture())).rejects.toThrow('simulated disk failure')
    expect(ledger.get('req-1')).toBeUndefined()
  })

  it('授权写不进台账时批准整体失败，状态退回 expired 而不是留下批准了的死账', async () => {
    const root = await newRoot()
    const { ctx, domain } = await boot(root)
    await new ApprovalLedger(domain).create(requestFixture())
    await ctx.fiber.dispose()

    const gated = await boot(root, rejectingBackend(root, 'grants'))
    await expect(gated.ledger.approve('req-1', {
      decidedBy: 'ou-alice', now: 2_000,
      grant: { grantId: 'g-1', toolName: 'write', argsDigest: argsDigest(escalated), grantExpiresAt: 3_000 },
    })).rejects.toThrow('simulated disk failure')
    expect(gated.ledger.get('req-1')!.status).toBe('expired')
    expect([...gated.ledger.grants.keys()]).toEqual([])

    // 补偿后的 expired 仍可再次批准 —— 用户重新点一次就能成
    const recovered = await boot(root)
    expect((await recovered.ledger.approve('req-1', {
      decidedBy: 'ou-alice', now: 4_000,
      grant: { grantId: 'g-2', toolName: 'write', argsDigest: argsDigest(escalated), grantExpiresAt: 5_000 },
    })).won).toBe(true)
  })
})

describe('argsDigest（§3.4.1，U1 实测钉死）', () => {
  it('justification 每次重放都重写，不参与指纹', () => {
    expect(argsDigest({ ...escalated, justification: '第一次的说明' }))
      .toBe(argsDigest({ ...escalated, justification: '获批的一次性提权：目标在工作区之外' }))
  })

  it('键序不同不算漂移', () => {
    expect(argsDigest({ content: 'hello', file_path: escalated.file_path }))
      .toBe(argsDigest({ file_path: escalated.file_path, content: 'hello' }))
  })

  it('嵌套参数里的键序也不算漂移，数组保序', () => {
    expect(argsDigest({ rows: [{ b: 2, a: 1 }], note: 'x' })).toBe(argsDigest({ note: 'x', rows: [{ a: 1, b: 2 }] }))
    expect(argsDigest({ rows: [1, 2] })).not.toBe(argsDigest({ rows: [2, 1] }))
  })

  it('被授权的字段一动就失配：sandbox_permissions 与 content 都是安全边界', () => {
    const authorized = argsDigest(escalated)
    expect(argsDigest({ ...escalated, sandbox_permissions: 'read-only' })).not.toBe(authorized)
    expect(argsDigest({ ...escalated, content: 'hello world' })).not.toBe(authorized)
    // 裸写调用与提权重试调用是两个不同的动作，不能互相当成同一个授权
    expect(argsDigest({ file_path: escalated.file_path, content: escalated.content })).not.toBe(authorized)
  })
})

describe('授权消费：E9 / E10', () => {
  it('digest 失配不消费，授权原样留给正确的重放', async () => {
    const { ledger } = await boot(await newRoot())
    await ledger.create(requestFixture())
    await ledger.approve('req-1', {
      decidedBy: 'ou-alice', now: 2_000,
      grant: { grantId: 'g-1', toolName: 'write', argsDigest: argsDigest(escalated), grantExpiresAt: 9_000 },
    })
    const drifted = { ...escalated, file_path: 'C:\\Users\\demo\\other.docx' }
    expect(await ledger.consumeGrant('write', argsDigest(drifted), 3_000)).toBeUndefined()
    expect([...ledger.grants.keys()]).toEqual(['g-1'])
    expect(await ledger.consumeGrant('write', argsDigest(escalated), 3_000)).toBeDefined()
  })

  it('超过 grantExpiresAt 不消费，走正常审批', async () => {
    const { ledger } = await boot(await newRoot())
    await ledger.create(requestFixture())
    await ledger.approve('req-1', {
      decidedBy: 'ou-alice', now: 2_000,
      grant: { grantId: 'g-1', toolName: 'write', argsDigest: argsDigest(escalated), grantExpiresAt: 5_000 },
    })
    expect(await ledger.consumeGrant('write', argsDigest(escalated), 5_000)).toBeUndefined()
    expect([...ledger.grants.keys()]).toEqual(['g-1'])
  })

  it('一次性的授权不会被第二个重放 turn 消费掉', async () => {
    const { ledger } = await boot(await newRoot())
    await ledger.create(requestFixture())
    const digest = argsDigest(escalated)
    await ledger.approve('req-1', {
      decidedBy: 'ou-alice', now: 2_000,
      grant: { grantId: 'g-1', toolName: 'write', argsDigest: digest, grantExpiresAt: 9_000 },
    })
    const results = await Promise.all([
      ledger.consumeGrant('write', digest, 3_000),
      ledger.consumeGrant('write', digest, 3_000),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect([...ledger.grants.keys()]).toEqual([])
  })
})
