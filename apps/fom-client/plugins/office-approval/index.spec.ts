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
    approvalMode: 'im',
    gatedTools: [],
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

/** 带**假 webServer** 的底座：捕获 `register` 的路由，用来分辨「挂没挂回调」这条形态差异。 */
async function contextWithFakeWebServer(): Promise<{ ctx: Context; routes: string[] }> {
  const ctx = await storageOnlyContext()
  const routes: string[] = []
  ctx.provide('webServer', {
    register: (route: { path: string }) => {
      routes.push(route.path)
      return () => {}
    },
  } as never)
  return { ctx, routes }
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

describe('审批入口形态（`approvalMode`）', () => {
  it('非法值 ⇒ 响亮抛（不静默当 im）', async () => {
    const ctx = await storageOnlyContext()
    await expect(apply(ctx, config({ approvalMode: 'bogus' }))).rejects.toThrow(/approvalMode/)
  })

  it('`native`＝只装闸：**不挂回调路由**；对照 `im` 会挂（这是两种形态唯一可直接观测的差异）', async () => {
    const native = await contextWithFakeWebServer()
    const release = await apply(native.ctx, config({ approvalMode: 'native' }))
    expect(native.routes).toEqual([])
    expect(release).toBeTypeOf('function')
    release()

    const im = await contextWithFakeWebServer()
    const releaseIm = await apply(im.ctx, config({ approvalMode: 'im' }))
    expect(im.routes).toEqual([config().callbackPath])
    releaseIm()
  })

  it('`native` 的判据是「闸还在」：台账仍被开出来（闸落快照靠它），只是没人替我们收决策', async () => {
    // 闸自身的行为由 `risk-gate.spec.ts` 覆盖（21 例）；这条只钉装配面：
    // native 形态照样要能开出 `approvalLedgerDomain`（闸的 `snapshot` 写在它上面），
    // 否则整层会在装配期就抛 —— 那样「只装闸」就成了「什么都没装」。
    const ctx = await storageOnlyContext()
    const release = await apply(ctx, config({ approvalMode: 'native' }))
    expect(release).toBeTypeOf('function')
    release()
  })
})

describe('租户解析（`tenantId` 空 ⇒ 从平台令牌 JWT 取）', () => {
  /** 造一个只带 `sub`/`tenant_id` 的 JWT（`userFromToken` 只看 payload 的 base64url）。 */
  function jwt(payload: Record<string, unknown>): string {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    return `header.${body}.signature`
  }

  it('配置留空 + 凭据里有真令牌 ⇒ 标记服务报出 JWT 里的租户', async () => {
    const ctx = await storageOnlyContext()
    ctx.provide('credentials', {
      resolve: async (ref: string) => ref === 'FOM_PLATFORM_TOKEN' ? { value: jwt({ sub: 'u1', tenant_id: 't-jwt' }) } : undefined,
    } as never)
    const release = await apply(ctx, config({ approvalMode: 'native', tenantId: '' }))
    const marker = ctx.get('officeRiskGate') as { tenant: () => string | undefined } | undefined
    expect(marker?.tenant()).toBe('t-jwt')
    release()
  })

  it('没登录（凭据里没令牌）⇒ 标记报 undefined（闸交棒，不拿假租户记账）', async () => {
    const ctx = await storageOnlyContext()
    ctx.provide('credentials', { resolve: async () => undefined } as never)
    const release = await apply(ctx, config({ approvalMode: 'native', tenantId: '' }))
    const marker = ctx.get('officeRiskGate') as { tenant: () => string | undefined } | undefined
    expect(marker?.tenant()).toBeUndefined()
    release()
  })
})
