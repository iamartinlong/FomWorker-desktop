/**
 * `office-reporter` 的 host 面（K3）。
 *
 * 职责：把 `office-meter`（用量）与 `office-audit`（审计）折叠成契约消息，经**传输**上报平台；
 * 断网走**离线队列**、按 `seq` 水位线增量补报。
 * 传输：配了 `platformUrl` → **WS 传输**（对齐 C3）；否则**内存 mock**。
 * 只依赖最小 `ctx` 面（`reflect.provide`），不引内核包类型。
 */

import { createMemoryQueue, createReporter, type Reporter } from './reporter.ts'
import { createMemoryTransport } from './transport.ts'
import { createWsTransport } from './ws-transport.ts'

export * from './collect.ts'
export * from './messages.ts'
export * from './reporter.ts'
export * from './transport.ts'
export * from './ws-transport.ts'

/** 插件所需的 ctx 最小面。 */
interface ProvideContext {
  reflect: { provide: (name: string, value: unknown) => void }
}

/** 上报器配置。 */
export interface OfficeReporterConfig {
  /** 平台 WS 地址；设了走 WS 传输，否则内存 mock。 */
  platformUrl?: string
  /** 服务令牌（WS `?token=`）。 */
  token?: string
}

/** 插件名。 */
export const name = 'office-reporter'

/**
 * 挂载上报器：造传输（WS 或 mock）+ 队列 + 上报器，`ctx.reflect.provide('officeReporter', …)`。
 * @param ctx - 插件上下文（最小面）。
 * @param config - `platformUrl` / `token`。
 */
export function apply(ctx: ProvideContext, config: OfficeReporterConfig = {}): void {
  const transport = config.platformUrl !== undefined
    ? createWsTransport({ url: config.platformUrl, token: config.token })
    : createMemoryTransport()
  const reporter: Reporter = createReporter({ transport, queue: createMemoryQueue() })
  ctx.reflect.provide('officeReporter', reporter)
}

export default { name, apply }
