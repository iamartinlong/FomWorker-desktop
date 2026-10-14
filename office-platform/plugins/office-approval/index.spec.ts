/**
 * 审批层装配入口（`index.ts` 的 `apply`）的渠道臂守卫验收。
 *
 * 其余审批 spec 都走 `test-harness.ts` 的**手工组合**（它自己开台账域、自己装闸与 responder），
 * 所以 `apply()` 这条产品真正挂载的路径在单元层一直是裸的；而 `boot()` 已经开过
 * `office_approval_ledger` 域（同一个 Context 只能开一次），所以这里挂一份**只到存储域为止**的
 * 最小组合，让 `apply` 真跑到渠道选择那一步。
 *
 * 守卫的形状是「静默降级」：配了 App ID 却没拿到 Secret 时，如果悄悄退回 `cardSink`，台账会看起来
 * 「卡已经发出去了」而没有任何人收到过 —— 审批层的每一次「已送达」都必须是真的，所以这里必须抛。
 * 两条用例一起钉住方向：**缺 Secret 必抛**（报的是变量名，不是任何别的错），**给了 Secret 就走到底**
 * （装配不被这道守卫拦，返回可用的 disposer）。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { apply, type OfficeApprovalConfig } from './index.ts'
import { newRoot } from './test-harness.ts'

/** 抛错里出现的那条环境变量名。正文里只出现**名字**，永不出现值（ME7 同一条纪律）。 */
const SECRET_ENV = 'OFFICE_APPROVAL_SPEC_SECRET'
/** 只在内存里存在的假值：这条路径不落盘、不进日志，只用来走通「有 Secret」那一臂。 */
const SECRET_VALUE = 'spec-only-in-memory-value'

function config(overrides: Partial<OfficeApprovalConfig> = {}): OfficeApprovalConfig {
  return {
    tenantId: 'tenant-spec',
    windowMs: 90_000,
    remindAfterMs: 60_000,
    callbackPath: '/office/approval/callback',
    verificationTokenEnv: 'OFFICE_APPROVAL_SPEC_TOKEN',
    approvers: ['ou_spec'],
    feishuAppId: '',
    feishuAppSecretEnv: SECRET_ENV,
    feishuTimeoutMs: 10_000,
    cardSink: '',
    neverSessionsInformativeNotice: '策略为 never 的会话不发放可批准的审批。',
    ...overrides,
  }
}

const contexts: Context[] = []

afterEach(async () => {
  delete process.env[SECRET_ENV]
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** 只挂到「能开台账域」为止：够 `apply` 走到渠道选择，不带 tools/schedule/webServer。 */
async function storageOnlyContext(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: await newRoot() })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  return ctx
}

describe('真飞书臂的凭据守卫（`feishuAppId` 非空 ⇒ 必须有 Secret）', () => {
  it('环境变量是空的 ⇒ 抛的就是这条守卫，报的是变量名', async () => {
    delete process.env[SECRET_ENV]
    const ctx = await storageOnlyContext()
    await expect(apply(ctx, config({ feishuAppId: 'cli_spec_app_id' })))
      .rejects.toThrow(SECRET_ENV)
  })

  it('环境变量有值 ⇒ 拦住的只有这道守卫：装配走到底并交回 disposer', async () => {
    process.env[SECRET_ENV] = SECRET_VALUE
    const ctx = await storageOnlyContext()
    // 真飞书臂在构造期只接指针（transport / token source 都不起网络），所以这份最小组合能一路装到底。
    // 「能装到底」就是这条用例的判据：它排除了「守卫写成了硬拒」与「凭据之外的别的东西也拦住了」。
    const release = await apply(ctx, config({ feishuAppId: 'cli_spec_app_id' }))
    expect(release).toBeTypeOf('function')
    release()
  })
})
