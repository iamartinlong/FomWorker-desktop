/**
 * 飞书工具层的挂载入口（设计小样 §4）。
 *
 * 三种装配形态（按配置）：
 * - **未配置**（`feishuAppId` 空）：**休眠**——记一行日志、不注册任何工具、不抛。
 *   产品 bundle 就是这一态：企业没配自己的飞书应用时，这一层安静地不在，而不是让整层装配失败。
 * - **半配置**（配了 App ID 却拿不到 Secret）：**响亮抛**（不静默退回一个「永远读不了」的工具）。
 * - **已配置**：注册工具；`readOnly` 为真时**只注册 3 个读工具（L0）**。
 *
 * ⚠️ **写工具（L2）必须有闸**：闸住在 `office-approval`（`installRiskGate`），它装好后会 provide
 * 标记服务 `officeRiskGate`。写工具因此**等那个标记出现才注册**（`ctx.inject(['officeRiskGate'])`）；
 * 闸不在 ⇒ 写工具**不注册**（fail-closed）——不是「无闸执行」，也不是「悄悄降级」。
 * 桌面 bundle 就按这个组合挂：`office-approval`（`approvalMode: native` + `gatedTools` 只列这 3 个写工具）
 * + 本层（`readOnly: false`）⇒ 审批落**内核原生面板**。
 *
 * **App Secret 落点（2026-10-17 改）**：**宿主凭据库优先**（`ctx.credentials` 的 `feishuAppSecretRef`），
 * **环境变量兜底**（`feishuAppSecretEnv`）。理由：装成桌面应用后让企业用户去设环境变量不现实，
 * 而「凭据走宿主凭据库」本来就是本项目的纪律（平台令牌就是这么放的）。App ID 仍走 config——它是标识、不是密。
 *
 * 复用审批层的传输与 token：`createHttpFeishuTransport` + `createTenantTokenSource`。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createHttpFeishuTransport } from '../office-approval/feishu-transport-http.ts'
import { createTenantTokenSource } from '../office-approval/feishu-channel.ts'
import { createFeishuTools } from './tools.ts'

export interface OfficeFeishuConfig {
  /** 飞书自建应用 App ID（标识符，非凭据）；空 ⇒ 本层休眠。 */
  feishuAppId: string
  /** 存 App Secret 的**宿主凭据库 ref**（首选；空 ⇒ 跳过凭据库）。 */
  feishuAppSecretRef: string
  /** 存 App Secret 的**环境变量名**（兜底；只给名字，运行时读值，绝不落 config）。 */
  feishuAppSecretEnv: string
  /** 传输基址，测试 / 代理可覆盖。 */
  baseUrl: string
  /**
   * **只注册读工具**（3 个 L0：doc_read / bitable_list_records / calendar_list_events）。
   * 产品 bundle 默认 `true`：写工具要过闸，而闸在审批层（见文件头）。
   */
  readOnly: boolean
}

const Config: z<OfficeFeishuConfig> = z.object({
  feishuAppId: z.string().default(''),
  feishuAppSecretRef: z.string().default('FOM_FEISHU_APP_SECRET'),
  feishuAppSecretEnv: z.string().default('FEISHU_APP_SECRET'),
  baseUrl: z.string().default('https://open.feishu.cn'),
  readOnly: z.boolean().default(false),
})

/** App Secret 的来源（只用于日志，绝不打印值）。 */
export type SecretSource = 'credentials' | 'env' | 'none'

/**
 * 按「凭据库 → 环境变量」的顺序取 App Secret。
 * @param ctx - 插件上下文（只要 `credentials` 可选服务）。
 * @param config - 配置（ref + env 变量名）。
 * @returns 值 + 来源（来源用于日志/报错，便于运维知道该往哪放）。
 */
export async function readAppSecret(
  ctx: Context,
  config: Pick<OfficeFeishuConfig, 'feishuAppSecretRef' | 'feishuAppSecretEnv'>,
): Promise<{ value: string; source: SecretSource }> {
  if (config.feishuAppSecretRef !== '') {
    const credentials = ctx.get('credentials') as { resolve?: (ref: string) => Promise<{ value: string } | undefined> } | undefined
    const stored = (await credentials?.resolve?.(config.feishuAppSecretRef))?.value ?? ''
    if (stored !== '') return { value: stored, source: 'credentials' }
  }
  const fromEnv = process.env[config.feishuAppSecretEnv] ?? ''
  if (fromEnv !== '') return { value: fromEnv, source: 'env' }
  return { value: '', source: 'none' }
}

export async function apply(ctx: Context, config: OfficeFeishuConfig): Promise<() => void> {
  const logger = ctx.logger('office-feishu')
  /** 运维可见性：真 web 进程里插件 logger 不进日志（M1 已知坑）⇒ 启停这类关键事实同时写 stderr。 */
  const report = (message: string): void => {
    logger.info(message)
    process.stderr.write(`[office-feishu] ${message}\n`)
  }

  if (config.feishuAppId === '') {
    // 休眠（产品 bundle 的默认态）：不是「配错了」，是「这台机器还没接飞书」。
    report('飞书工具层休眠：未配置 feishuAppId（企业配好自己的飞书应用后即可启用）')
    return () => {}
  }

  const secret = await readAppSecret(ctx, config)
  if (secret.value === '') {
    // 半配置：把**两个落点**都点名 —— 只说「Secret 是空的」等于让人自己去猜该写哪。
    throw new Error(
      `office-feishu: feishuAppId 已配置，但 App Secret 取不到`
      + `（凭据库 ref "${config.feishuAppSecretRef}" 与环境变量 "${config.feishuAppSecretEnv}" 都是空的）`,
    )
  }

  const transport = createHttpFeishuTransport({ baseUrl: config.baseUrl })
  const tokens = createTenantTokenSource(transport, config.feishuAppId, secret.value)
  const tools = createFeishuTools(transport, tokens)
  const readReleases = [
    ctx.tools.register(tools.docRead),
    ctx.tools.register(tools.bitableListRecords),
    ctx.tools.register(tools.calendarListEvents),
  ]
  if (config.readOnly) {
    report(`飞书工具层已装配（只读，Secret 来源：${secret.source}）：读 L0（doc_read / bitable_list_records / calendar_list_events）`)
    return () => {
      for (const release of readReleases) release()
    }
  }

  // **写工具必须有闸**（结构互锁，不靠挂载顺序靠得住）：等 `officeRiskGate` 出现才注册写工具；
  // 闸不在 ⇒ 写工具**不注册**（fail-closed），而不是无闸执行。
  ctx.inject(['officeRiskGate'], (scoped) => {
    scoped.effect(() => {
      const releases = [
        ctx.tools.register(tools.docCreate),
        ctx.tools.register(tools.bitableCreateRecord),
        ctx.tools.register(tools.calendarCreateEvent),
      ]
      report('飞书写工具（L2）已装配：doc_create / bitable_create_record / calendar_create_event')
      return () => {
        for (const release of releases) release()
      }
    }, 'office-feishu: 写工具（L2，需风险闸 officeRiskGate）')
  })
  report(`飞书工具层已装配（Secret 来源：${secret.source}）：读 L0 已注册；写 L2 等风险闸（officeRiskGate）出现后注册 —— 闸不在则写工具不注册（fail-closed）`)
  return () => {
    for (const release of readReleases) release()
  }
}

export const OfficeFeishu = {
  name: 'office-feishu',
  inject: ['tools', 'credentials'],
  Config,
  apply,
}

export default OfficeFeishu
