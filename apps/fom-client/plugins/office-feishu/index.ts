/**
 * 飞书工具层的挂载入口（设计小样 §4）。**只读先行**：先装 `feishu_doc_read`（L0）。
 *
 * 配置与审批层同取向：`feishuAppId` 非空却拿不到 Secret ⇒ **响亮抛**（不静默退回一个「永远读不了」
 * 的工具）；`feishuAppId` 空 ⇒ 也抛（本层没有可鉴权的身份，装一半比不装更难查）。
 *
 * 复用审批层的传输与 token：`createHttpFeishuTransport` + `createTenantTokenSource`。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createHttpFeishuTransport } from '../office-approval/feishu-transport-http.ts'
import { createTenantTokenSource } from '../office-approval/feishu-channel.ts'
import { createFeishuTools } from './tools.ts'

export interface OfficeFeishuConfig {
  /** 飞书自建应用 App ID（标识符，非凭据）。 */
  feishuAppId: string
  /** 存 App Secret 的**环境变量名**（只给名字，运行时读值，绝不落 config）。 */
  feishuAppSecretEnv: string
  /** 传输基址，测试 / 代理可覆盖。 */
  baseUrl: string
}

const Config: z<OfficeFeishuConfig> = z.object({
  feishuAppId: z.string().default(''),
  feishuAppSecretEnv: z.string().default('FEISHU_APP_SECRET'),
  baseUrl: z.string().default('https://open.feishu.cn'),
})

export function apply(ctx: Context, config: OfficeFeishuConfig): () => void {
  if (config.feishuAppId === '') {
    throw new Error('office-feishu: feishuAppId 是空的（要么配好，要么别挂这一层）')
  }
  const appSecret = process.env[config.feishuAppSecretEnv] ?? ''
  if (appSecret === '') {
    throw new Error(`office-feishu: feishuAppId 已配置，但环境变量 ${config.feishuAppSecretEnv} 是空的`)
  }

  const transport = createHttpFeishuTransport({ baseUrl: config.baseUrl })
  const tokens = createTenantTokenSource(transport, config.feishuAppId, appSecret)
  const tools = createFeishuTools(transport, tokens)
  const releases = [
    ctx.tools.register(tools.docRead),
    ctx.tools.register(tools.docCreate),
    ctx.tools.register(tools.bitableListRecords),
    ctx.tools.register(tools.bitableCreateRecord),
    ctx.tools.register(tools.calendarListEvents),
    ctx.tools.register(tools.calendarCreateEvent),
  ]
  ctx.logger('office-feishu').info('飞书工具层已装配：读 L0（doc_read / bitable_list_records / calendar_list_events）/ 写 L2（doc_create / bitable_create_record / calendar_create_event）')
  return () => {
    for (const release of releases) release()
  }
}

export const OfficeFeishu = {
  name: 'office-feishu',
  inject: ['tools'],
  Config,
  apply,
}

export default OfficeFeishu
