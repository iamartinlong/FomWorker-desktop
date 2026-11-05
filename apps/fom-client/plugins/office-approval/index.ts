/**
 * 审批层的产品入口（§8 第 7 步：真实组合）。
 *
 * 六个部件在内核的**真 profile** 里装配：台账落在 `storage-domain` 的 json 后端，
 * 催办用真 `schedule`，回调经真 `webServer`，唤醒经真 `sessionController`。
 * 挂载只经 `--patch` 的 `- insert:` 行（同目录的 `office-approval.patch.yml`），内核零改动。
 *
 * `inject` 里每一项都是**必需**服务：cordis 的语义是「服务不齐就不加载插件」
 * （`vendor/cordis/src/registry.ts:105-106`），所以 CLI 形态下没有 `schedule` 时
 * 这一层整体不装 —— 那是「没有 IM 批准入口」，不是「放宽了审批」：内核自带的询问照旧生效。
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { approvalLedgerDomain, ApprovalLedger, type ApprovalRequestRecord } from './ledger.ts'
import { installRiskGate, builtinRiskRules, type RiskRuleTable } from './risk-gate.ts'
import { createTenantResolver } from './tenant.ts'
import { userFromToken } from '../office-login/session.ts'
import {
  installApprovalResponder, PendingApprovalWindows,
  type ApprovalCard, type ApprovalChannel,
} from './responder.ts'
import { installApprovalCallbackRoute } from './callback-route.ts'
import { createApprovalRecovery } from './recovery.ts'
import { installApprovalSweeper, type SweeperTargets } from './sweeper.ts'
import {
  createTenantTokenSource, installFeishuApprovalChannel, type FeishuApprovalChannel,
} from './feishu-channel.ts'
import { createHttpFeishuTransport } from './feishu-transport-http.ts'

export interface OfficeApprovalConfig {
  /**
   * 租户 id 的**兜底/覆盖**：**空 ⇒ 从平台令牌 JWT 的 `tenant_id` 解**（桌面形态，登录后才有）；
   * 非空 ⇒ 恒用它（M1 / 单租户形态）。解不出租户时闸**交棒**（不拿假租户记账，也不放行）。
   */
  tenantId: string
  /** 同步窗口 D3；超窗一律 `cancelled`，不记成拒绝。 */
  windowMs: number
  /** §3.5 催办：落账后多久重推一次。 */
  remindAfterMs: number
  /** IM 回调路径。命名路由在 dsh 的 token 守卫**之外**，真实性只靠签名（§3.7①）。 */
  callbackPath: string
  /** Verification Token 所在的**环境变量名**；正文里不落密钥，`--dump-config` 才可放心看。 */
  verificationTokenEnv: string
  /** 允许裁决的 IM open_id 名单。空名单 = 谁都批不了（fail-closed）。 */
  approvers: string[]
  /**
   * 真飞书渠道的 App ID。空字符串 = 留在 `cardSink` 测试臂 —— 第 7 步那条
   * 「真 profile + 真 patch 的装配证据」必须能在没有任何外部应用时重跑，所以那条臂留着。
   */
  feishuAppId: string
  /** App Secret 所在的**环境变量名**；与 `verificationTokenEnv` 同一条纪律：正文不落密钥。 */
  feishuAppSecretEnv: string
  /** 单次飞书调用的上限。同步窗口最短的那条臂不该被一次挂死的网络请求拖住。 */
  feishuTimeoutMs: number
  /** 卡片落盘文件；空字符串 = 只写日志。`feishuAppId` 非空时不生效。 */
  cardSink: string
  /**
   * §9 U8（定案＝候选①）：会话策略为 `never` 的档位**不发放可批准的审批**。
   * 内核在派发之前就判掉提权（`approval/request` 一次都不触发，`responder.ts:134` 的 `consumeGrant`
   * 根本没机会跑），台账里留下的 `pending` 只是审计留痕；而 sweeper 认台账状态不认会话策略，
   * 催办那张卡照旧会推出去。这句声明必须写在配置面上（`--dump-config` 可见、装配日志回显），
   * 否则审批人手里会出现一批永远批不动的卡而不知道原因。它是**信息性残留**，不是放行口子 ——
   * 点批准既不执行、也**不**承诺「下一个回合自动执行」（§9 U10 的路径分支原则覆盖这一支）。
   */
  neverSessionsInformativeNotice: string
  /**
   * **审批入口形态**：
   * - `im`（默认，＝ M1 形态）：卡片渠道 + responder + 回调路由 + 催办，全部装配 —— IM 上可批。
   * - `native`：**只装风险闸**（+ 台账），不装渠道/responder/回调/催办 ⇒ 闸发出的 `ask`
   *   由**内核原生面板**接走（G13「桌面 UI 为主」，M1 已验该面板会显示 `approval-decision`）。
   *   代价：我们自己的台账停在 `pending`（**决策只在内核会话日志里**，不是没有记录）。
   *   ⚠️ 启用前要拍「闸的适用范围」：内置工具里的对外可见类（`web_search`/`web_fetch`）按 U11 也要卡
   *   ⇒ 一桌面一用户的形态下是明显摩擦；出路是聚合审批或租户级白名单，**不许**悄悄写回 L0。
   */
  approvalMode: string
  /**
   * **闸的适用范围**（缺省/空 ⇒ 全量）：非空时只闸这些工具名，其余交棒给内核自己的闸。
   * 桌面形态用「只闸我们的产品工具」（见 `risk-gate.ts` 的 `gatedTools` 注释与 §9 U11）。
   */
  gatedTools: string[]
}

/**
 * 分级字典就是 `risk-gate.ts` 里那一份（§5 补全到覆盖 dsh web 真实内置工具集，F-H）。
 * 字典住在闸那一侧而不是这里，是因为它必须能被单测直接驱动：第 2 步的测试跑的是
 * `test-harness.ts` 里的**样例**字典，产品字典一行都没被断言过 —— 于是「`ask_user_question`
 * 也要一张 owner 批准卡」这种只在真字典上才暴露的问题，一路活到了第 8 步真人点击的现场。
 *
 * `cardSink` 那条臂里「写到 `outbox/` 当成对外可见的发送」是 spike 的造法，真字典要接架构方案 §3
 * 的产品目录（租户自建规则），不在这里硬编码第二份。
 */
const rules: RiskRuleTable = builtinRiskRules

/**
 * 卡片渠道的 spike 实现：把该发的东西逐条落盘，结局仍由第 4 步的**真回调路由**进来。
 *
 * 存在的理由只有一条：第 8 步才有人工可用的飞书应用，而本步要验的是装配
 * （waterfall 顺序、真台账、真 webServer、冷会话唤醒），不是飞书的响应形状。
 * `send` 必须真的 reject 才算 E13 —— 这里不模拟失败，失败留给第 8 步。
 */
class CardSinkChannel implements ApprovalChannel {
  private directoryReady: Promise<void> | undefined

  constructor(
    private readonly ctx: Context,
    private readonly path: string,
  ) {}

  /** 催办重推（sweeper 的 `remind` 目标）。 */
  async pushReminder(record: ApprovalRequestRecord): Promise<void> {
    await this.write('remind', record.requestId, { status: record.status, toolName: record.toolName })
  }

  /** 过期作废（sweeper 的 `expire` 目标）。 */
  async markExpired(record: ApprovalRequestRecord): Promise<void> {
    await this.write('expire', record.requestId, { status: record.status, toolName: record.toolName })
  }

  async send(record: ApprovalRequestRecord): Promise<ApprovalCard> {
    await this.write('send', record.requestId, {
      riskLevel: record.riskLevel,
      actionSummary: record.actionSummary,
      // 参数原文只进台账，不进卡片正文（§4 最小暴露）；这里落的是给人看的那句摘要。
      windowEndsAt: record.windowEndsAt,
    })
    return {
      cardId: `sink-${record.requestId}`,
      // 这张卡自己不等点击：点击是经回调路由 → 恢复路径 → `windows.settle` 进来的，
      // 所以渠道这一侧只在窗口 abort 时收摊。
      waitForClick: signal => new Promise<undefined>(resolve => {
        if (signal.aborted) return resolve(undefined)
        signal.addEventListener('abort', () => resolve(undefined), { once: true })
      }),
    }
  }

  async update(card: ApprovalCard, text: string): Promise<void> {
    await this.write('update', card.cardId, { text })
  }

  /** 「转后台但仍可批准」：与 `recall` 的区别就是要留下能点的那张卡（F-E）。 */
  async defer(card: ApprovalCard, text: string): Promise<void> {
    await this.write('defer', card.cardId, { text })
  }

  async recall(card: ApprovalCard, text: string): Promise<void> {
    await this.write('recall', card.cardId, { text })
  }

  private async write(kind: string, id: string, payload: unknown): Promise<void> {
    const line = JSON.stringify({ at: new Date().toISOString(), kind, id, payload })
    this.ctx.logger('office-approval').info(`card ${kind} ${id}`)
    if (this.path === '') return
    await (this.directoryReady ??= mkdir(dirname(resolve(this.path)), { recursive: true }).then(() => {}))
    await appendFile(resolve(this.path), `${line}\n`, 'utf8')
  }
}

/** 真 `sessionController` 的结构面：只用到 `resolveAgent`，不焊内核包的类型导出。 */
interface SessionControllerLike {
  resolveAgent: (sessionId: SessionId) => Promise<{ agent?: Agent, error?: unknown }>
}

/** 装配后的渠道：responder 要 `ApprovalChannel`，sweeper 要那两个卡片动作。 */
type AssembledChannel = ApprovalChannel & Pick<FeishuApprovalChannel, 'pushReminder' | 'markExpired'>

/** 平台令牌的凭据 ref（与 `office-login`/`office-skills`/`office-billing` 同一名；跨插件不引值，故各自声明）。 */
export const PLATFORM_TOKEN_REF = 'FOM_PLATFORM_TOKEN'

/**
 * 卡片渠道的两条臂。
 *
 * **配了 App ID 却没有 Secret 就直接抛**，不让它静默退回 `cardSink`：那会让台账看起来
 * 像"卡已经发出去了"，而实际上没有任何人收到过 —— 审批层的每一次「已送达」都必须是真的。
 * 抛出去之后整层不装（`inject` 全为必需服务），内核自带的询问面板照旧生效，
 * 那是「没有 IM 批准入口」，不是「放宽了审批」。
 *
 * 收件人取 `approvers` 而不是另配一份名单：渠道注释里那两句是同一个事实的两个视角，
 * 配成两个列表迟早漂移成「卡发给了点不动的人」。名单为空时 `recipientsOf` 给 `undefined`
 * ⇒ 渠道 reject ⇒ responder 走 E13 交棒给内核原生面板 —— 也不会误放行。
 */
function createCardChannel(
  ctx: Context,
  config: OfficeApprovalConfig,
  ledger: ApprovalLedger,
  report: (message: string) => void,
): AssembledChannel {
  if (config.feishuAppId === '') return new CardSinkChannel(ctx, config.cardSink)
  const appSecret = process.env[config.feishuAppSecretEnv] ?? ''
  if (appSecret === '') {
    throw new Error(`office-approval: feishuAppId 已配置，但环境变量 ${config.feishuAppSecretEnv} 是空的`)
  }
  const transport = createHttpFeishuTransport({ timeoutMs: config.feishuTimeoutMs })
  const recipients = () => (config.approvers.length > 0 ? config.approvers : undefined)
  return installFeishuApprovalChannel({
    transport,
    tokens: createTenantTokenSource(transport, config.feishuAppId, appSecret),
    ledger,
    recipientsOf: recipients,
    // 本机单人部署：发起人与审批人是同一个人。多用户要接产品目录（U2），不在这里猜。
    initiatorOf: () => config.approvers[0],
    // 送卡失败在决策上是「交棒给内核原生面板」（E13，不放宽审批），但在运维上必须留下声音：
    // 否则「审批人没收到卡」与「审批人没看见卡」在台账里长得一模一样 —— 第 8 步真进程冒烟
    // 就是靠这条才看出卡片根本没发出去（`onFailure` 不接，渠道只把错误吞进 per-recipient 循环）。
    onFailure: (error, info) => report(`${info.path} ${info.requestId}: ${String(error)}`),
  })
}

/**
 * 装出与产品 patch 相同的组合。返回释放全部监听器的句柄，交给 `ctx.effect`。
 */
export async function apply(ctx: Context, config: OfficeApprovalConfig): Promise<() => void> {
  const logger = ctx.logger('office-approval')
  if (config.approvalMode !== 'im' && config.approvalMode !== 'native') {
    throw new Error(`office-approval: approvalMode 非法（须为 im/native）：${config.approvalMode}`)
  }
  const native = config.approvalMode === 'native'
  const ledger = new ApprovalLedger(await ctx.storageDomain.open(approvalLedgerDomain))

  /**
   * 租户解析：配置写了就恒用它（M1/单租户）；否则读平台令牌解 JWT 的 `tenant_id`（桌面形态）。
   * 起手 `await` 一次，之后按 TTL 后台刷（令牌换人/登出在 10 秒内被跟上）。
   */
  const resolver = createTenantResolver({
    ...(config.tenantId === '' ? {} : { fixed: config.tenantId }),
    readToken: async () => {
      const credentials = ctx.get('credentials') as { resolve?: (ref: string) => Promise<{ value: string } | undefined> } | undefined
      return (await credentials?.resolve?.(PLATFORM_TOKEN_REF))?.value ?? ''
    },
    parseTenant: (token) => {
      const user = userFromToken(token)
      return user === null || user.tenantId === '' ? undefined : user.tenantId
    },
    onError: error => logger.warn(`租户解析失败（保留旧值）：${String((error as Error)?.message ?? error)}`),
  })
  await resolver.refresh()

  /** 闸装上了就给个标记：写工具那一侧（`office-feishu`）据此**要求**闸在场，否则拒绝注册写工具。 */
  const provideGateMarker = (): void => {
    ctx.effect(() => ctx.reflect.provide('officeRiskGate', {
      installed: true,
      /** 当前解析到的租户（诊断/联调用；解不出 ⇒ undefined）。 */
      tenant: () => resolver.current()?.tenantId,
    }))
  }

  /** 只装闸时要装的那一半：闸本身（渠道/responder/回调/催办都不装）。 */
  if (native) {
    installRiskGate(ctx, {
      ledger,
      rules,
      tenantOf: () => resolver.current(),
      windowMs: config.windowMs,
      ...(config.gatedTools.length === 0 ? {} : { gatedTools: config.gatedTools }),
    })
    provideGateMarker()
    logger.info(`审批层已装配（**只装闸**）：租户 ${config.tenantId === '' ? '取自平台令牌 JWT' : config.tenantId}，窗口 ${config.windowMs}ms，`
      + `范围 ${config.gatedTools.length === 0 ? '全量' : config.gatedTools.join('/')}，`
      + '审批落**内核原生面板**；我们自己的台账停在 pending（决策只在内核会话日志里）')
    logger.info(`档位声明：${config.neverSessionsInformativeNotice}`)
    return () => {}
  }

  const windows = new PendingApprovalWindows()

  const channel = createCardChannel(ctx, config, ledger, message => {
    logger.warn(message)
    // 第 8 步实测：真 `web` 进程里 `logger.warn` 既不落到 stdout，也不落到 `.dsh/logs/startup-*.log`
    // —— 那次卡片根本没发出去（`99992402`），而进程外观一切正常。运维必须能在现场听见这句话，
    // 所以这一行不是临时诊断，是「送达失败要有声音」的落点；决策语义不变（仍然是 E13 交棒）。
    process.stderr.write(`[office-approval] ${message}\n`)
  })
  const targets: SweeperTargets = {
    remind: record => channel.pushReminder(record),
    expire: record => channel.markExpired(record),
  }

  const recover = createApprovalRecovery({
    ledger,
    windows,
    // 冷会话必须能被起来（E3）：这一句是本步要验的头号问题，测试端口给不了答案。
    resolveAgent: async (sessionId) => {
      const controller = ctx.get('sessionController') as SessionControllerLike | undefined
      if (controller === undefined) return undefined
      const found = await controller.resolveAgent(SessionId(sessionId))
      return found.error === undefined ? found.agent : undefined
    },
    // 投递确认 = 至少有一个持久化应答者（`packages/core/session/src/index.ts:1190`）。
    flush: session => ctx.sessions.flush(session as Session),
    onFailure: (failure, event, error) => {
      logger.warn(`恢复失败 ${failure} ${event.record.requestId}: ${String(error ?? '无异常')}`)
    },
  })

  installRiskGate(ctx, {
    ledger,
    rules,
    // 租户来自配置或平台令牌 JWT（见上面的 resolver）。
    tenantOf: () => resolver.current(),
    windowMs: config.windowMs,
    ...(config.gatedTools.length === 0 ? {} : { gatedTools: config.gatedTools }),
  })
  provideGateMarker()

  const releaseResponder = installApprovalResponder(ctx, {
    ledger,
    channel,
    windows,
    onHandoffError: (requestId, error) => logger.warn(`交棒退役失败 ${requestId}: ${String(error)}`),
  })

  // 验签密钥没配 = IM 批准入口**整体**不可用（回调一律 401，见 `callback-route.ts` 那道 fail-closed），
  // 不是「签名恰好差一点」。这句必须让现场听见：否则审批人一直点卡、卡上写着处理失败，而没人知道根因是一行环境变量。
  if ((process.env[config.verificationTokenEnv] ?? '') === '') {
    logger.warn(`回调验签密钥未配置（环境变量 ${config.verificationTokenEnv}）⇒ 回调一律 401，IM 批准入口不可用；内核原生询问面板照旧`)
  }

  installApprovalCallbackRoute(ctx, {
    ledger,
    tenantId: config.tenantId,
    path: config.callbackPath,
    verificationToken: () => process.env[config.verificationTokenEnv] ?? '',
    // 名单解析不出来 → 拒（§4）。L4「只认 owner」要接产品字典，本步不硬编码。
    approversOf: () => (config.approvers.length > 0 ? config.approvers : undefined),
    // U10：落账前先试交活窗口。有在飞的调用在等这条记录 → 当场兑现、不落批件（存在期因此不存在），
    // 卡片由 responder 置灰；没人等才落批件走唤醒重放。同步，不 await（3 秒窗口）。
    handToWindow: (requestId, handoff) => windows.settle(requestId, handoff),
    onSettled: event => recover(event),
    onSettledError: (error, event) => logger.warn(`落账后通知失败 ${event.record.requestId}: ${String(error)}`),
    onAuditError: (error, denial) => logger.warn(`越权审计写不下去 ${denial.requestId}: ${String(error)}`),
  })

  const releaseSweeper = installApprovalSweeper(ctx, {
    ledger,
    targets,
    remindAfterMs: config.remindAfterMs,
    onFailure: event => logger.warn(`催办/过期失败 ${event.requestId}/${event.stage}: ${String(event.error)}`),
  })

  logger.info(`审批层已装配：租户 ${config.tenantId}，窗口 ${config.windowMs}ms，回调 ${config.callbackPath}，`
    + `渠道 ${config.feishuAppId === '' ? 'cardSink' : `feishu/${config.feishuAppId}`}，`
    + `审批人 ${config.approvers.length} 人`)
  // §9 U8 候选①：策略 never 的档位不发可批卡 —— 这句声明必须让现场看见（配置面 `--dump-config` 也留一份）。
  // 之所以回显在装配日志而不是只在正文里，是因为 sweeper 认台账状态不认会话策略，never 会话的催办卡照旧会推；
  // 没有这句话，审批人手里就多出一批「点了什么也不会发生」的卡而无人解释（不是 fail-open，是空承诺）。
  logger.info(`档位声明：${config.neverSessionsInformativeNotice}`)

  return () => {
    releaseResponder()
    releaseSweeper()
  }
}

/** 形状抄 `packages/schedule/schedule/src/index.ts:102`：`z<Config>` 标注 + `z.object` 取值。 */
const Config: z<OfficeApprovalConfig> = z.object({
  tenantId: z.string().default(''),
  windowMs: z.number().min(1_000).max(600_000).default(90_000),
  remindAfterMs: z.number().min(60_000).default(30 * 60_000),
  callbackPath: z.string().default('/office/approval/callback'),
  verificationTokenEnv: z.string().default('OFFICE_APPROVAL_VERIFICATION_TOKEN'),
  approvers: z.array(z.string()).default([]),
  feishuAppId: z.string().default(''),
  feishuAppSecretEnv: z.string().default('FEISHU_APP_SECRET'),
  feishuTimeoutMs: z.number().min(500).max(30_000).default(10_000),
  cardSink: z.string().default(''),
  neverSessionsInformativeNotice: z.string().default(
    '策略为 never 的会话不发放可批准的审批：这里出现的任何卡片只是信息性残留，点批准不会执行任何动作。',
  ),
  approvalMode: z.string().default('im'),
  gatedTools: z.array(z.string()).default([]),
})

export const OfficeApproval = {
  name: 'office-approval',
  inject: ['tools', 'approval', 'sessions', 'storageDomain', 'schedule', 'sessionController', 'sessionPersistence'],
  Config,
  apply,
}

export default OfficeApproval
