/**
 * `office-reporter` 的 host 面（K3）。
 *
 * 职责：把 `office-meter`（用量）与 `office-audit`（审计）折叠成契约消息，经**传输**上报平台；
 * 断网走**离线队列**、按 `seq` 水位线增量补报。
 * 传输：配了 `platformUrl` → 默认 **HTTP 传输**（平台真端点 `/api/report/{usage,audit}`，Bearer＝客户端令牌）；
 * `transport:'ws'` 走 C3 WS 契约（平台暂无 WS 端点）；否则内存 mock。
 * 只依赖最小 `ctx` 面（`reflect.provide` + `credentials`），不引内核包类型。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { userFromToken } from '../office-login/session.ts'
import { createMemoryQueue, createReporter, type Reporter } from './reporter.ts'
import { createHttpTransport, createMemoryTransport, type ReporterTransport } from './transport.ts'
import { createTurnEndTrigger, syncSessionLogs, type SessionSyncResult } from './trigger.ts'
import { createWsTransport } from './ws-transport.ts'

export * from './collect.ts'
export * from './messages.ts'
export * from './reporter.ts'
export * from './transport.ts'
export * from './trigger.ts'
export * from './ws-transport.ts'

/** 平台令牌的凭据 ref（与 `office-login` 同一名）。 */
export const PLATFORM_TOKEN_REF = 'FOM_PLATFORM_TOKEN'

/** flush 路由（认证的 `/api` 通道；联调/运维手动冲队列用）。 */
export const FLUSH_ROUTE = '/api/office/reporter/flush'

/** 折叠触发路由（认证的 `/api` 通道）：扫会话日志 → 折用量 → 冲队列。 */
export const SYNC_ROUTE = '/api/office/reporter/sync'

/** 解析 `$DSH_HOME`（与内核一致：环境变量优先，否则 `~/.dsh`）。 */
function dshHome(): string {
  const home = process.env.DSH_HOME
  return home !== undefined && home !== '' ? home : join(homedir(), '.dsh')
}

/** 插件所需的 ctx 最小面。 */
interface ReporterContext {
  get(name: string): unknown
  on(name: string, handler: (...args: unknown[]) => void): () => void
  inject(names: readonly string[], callback: (child: ReporterContext) => void): void
  effect(callback: () => (() => void) | void, label?: string): void
  reflect: { provide: (name: string, value: unknown) => void }
}

/** `connection` 服务的最小面（认证 Fetch 路由）。 */
interface ConnectionLike {
  fetch: {
    register(route: {
      path: string
      methods: readonly string[]
      requestBody: 'buffered' | 'streaming'
      fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

/** 上报器配置。 */
export interface OfficeReporterConfig {
  /** 平台 API 基址（如 `http://localhost:5028`）；设了默认走 HTTP 传输。 */
  platformUrl?: string
  /** 传输方式；缺省：`platformUrl` 设了 → `http`，否则 `memory`。 */
  transport?: 'http' | 'ws' | 'memory'
  /** 平台令牌的凭据 ref（默认 `FOM_PLATFORM_TOKEN`）。 */
  tokenRef?: string
  /** WS 服务令牌（`?token=`；`transport:'ws'` 时用）。 */
  token?: string
  /** 自动折叠触发间隔（毫秒）；`>0` 时起定时器周期 sync（缺省 0＝只在路由触发）。 */
  syncIntervalMs?: number
  /**
   * **事件驱动触发**：监听内核 `session/event`，遇 **`turn/end`** 时防抖触发 sync。
   * 缺省 `true`（memory 传输时也生效；测试/纯 mock 场景可关）。
   */
  syncOnTurnEnd?: boolean
  /** `turn/end` 防抖窗口（毫秒，缺省 800）。 */
  turnEndDebounceMs?: number
  /** 每轮 flush 最多送出的条数（缺省 50）：大积压不一次性轰平台（它按 IP 限流 `/report/*`）。 */
  maxPerFlush?: number
  /**
   * **缺省模型**：会话日志里没有模型名时用它（内核 `assistant/message` 的 data **不带 `model`**，
   * 只有 `message`/`stream`/`usage`）——平台 `/report/usage` 要求 `model` 非空，缺了就 **400**
   * ⇒ 用量永远上报不成功。由部署填（本机 dev＝网关模型 id）。
   */
  defaultModel?: string
}

/** 插件名。 */
export const name = 'office-reporter'

/**
 * 挂载上报器：造传输（HTTP / WS / mock）+ 队列 + 上报器，`ctx.reflect.provide('officeReporter', …)`。
 * @param ctx - 插件上下文（最小面）。
 * @param config - `platformUrl` / `transport` / `tokenRef` / `token`。
 */
export function apply(ctx: ReporterContext, config: OfficeReporterConfig = {}): void {
  const mode = config.transport ?? (config.platformUrl === undefined ? 'memory' : 'http')
  const tokenRef = config.tokenRef ?? PLATFORM_TOKEN_REF
  /** 取客户端访问令牌（平台 Bearer）。 */
  const readToken = async (): Promise<string> => {
    const credentials = ctx.get('credentials') as { resolve?: (ref: string) => Promise<{ value: string } | undefined> } | undefined
    return (await credentials?.resolve?.(tokenRef))?.value ?? ''
  }
  let transport: ReporterTransport
  if (mode === 'http') {
    if (config.platformUrl === undefined || config.platformUrl === '') {
      throw new Error('office-reporter: transport=http 需要 platformUrl')
    }
    transport = createHttpTransport({ platformUrl: config.platformUrl, token: readToken })
  } else if (mode === 'ws') {
    transport = createWsTransport({ url: config.platformUrl ?? '', ...(config.token === undefined ? {} : { token: config.token }) })
  } else {
    transport = createMemoryTransport()
  }
  const reporter: Reporter = createReporter({
    transport,
    queue: createMemoryQueue(),
    ...(config.maxPerFlush === undefined ? {} : { maxPerFlush: config.maxPerFlush }),
  })
  ctx.reflect.provide('officeReporter', reporter)

  /** 折叠触发：读会话日志 → 折用量 → 冲队列（身份取自平台令牌 JWT）。 */
  const sync = async (): Promise<SessionSyncResult> => {
    const token = await readToken()
    const user = token === '' ? null : userFromToken(token)
    if (user === null || user.tenantId === '' || user.userId === '') {
      throw new Error('未登录：拿不到平台身份（先在「登录」面板登录）')
    }
    return syncSessionLogs(reporter, dshHome(), {
      tenantId: user.tenantId,
      userId: user.userId,
      source: 'platform',
      ...(config.defaultModel === undefined || config.defaultModel === '' ? {} : { defaultModel: config.defaultModel }),
    })
  }

  if (mode === 'memory') return

  // 定时折叠触发（可选；缺省只在路由触发）。
  const intervalMs = config.syncIntervalMs ?? 0
  if (intervalMs > 0) {
    const timer = setInterval(() => {
      void sync().catch(() => {
        /* 定时触发失败静默（消息留队列，下次再冲） */
      })
    }, intervalMs)
    ctx.effect(() => () => {
      clearInterval(timer)
    }, 'office-reporter: 定时折叠触发')
  }

  // 事件驱动触发（内核标准做法）：`session/event` 的 **`turn/end`** → 防抖 sync。
  if (config.syncOnTurnEnd ?? true) {
    const trigger = createTurnEndTrigger({
      sync,
      ...(config.turnEndDebounceMs === undefined ? {} : { debounceMs: config.turnEndDebounceMs }),
      // 限流退避中就别再冲：等下一次 turn/end（或定时触发）——消息留在队列，不丢。
      blocked: () => {
        const until = reporter.blockedUntilMs()
        return until !== undefined && Date.now() < until
      },
    })
    ctx.effect(() => {
      const off = ctx.on('session/event', (...args) => {
        trigger.onEvent((args[1] as { type?: unknown } | undefined)?.type)
      })
      return () => {
        off()
        trigger.dispose()
      }
    }, 'office-reporter: turn/end 事件驱动触发')
  }

  // 认证路由：手动 flush / sync。
  ctx.inject(['connection'], (connCtx) => {
    connCtx.effect(() => {
      const conn = connCtx.get('connection') as ConnectionLike | undefined
      if (conn === undefined) return () => {}
      const reply = (body: unknown, status: number): Response =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      const disposeFlush = conn.fetch.register({
        path: FLUSH_ROUTE,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async () => {
          try {
            return reply({ ok: true, ...(await reporter.flush()) }, 200)
          } catch (error) {
            const hint = reporter.retryAfterMs()
            return reply({
              ok: false,
              message: String((error as Error)?.message ?? error),
              pending: reporter.pendingCount(),
              ...(hint === undefined ? {} : { retryAfterMs: hint }),
            }, 200)
          }
        },
      })
      const disposeSync = conn.fetch.register({
        path: SYNC_ROUTE,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async () => {
          try {
            const result = await sync()
            return reply({ ok: result.error === undefined, ...result }, 200)
          } catch (error) {
            return reply({ ok: false, message: String((error as Error)?.message ?? error) }, 200)
          }
        },
      })
      return () => {
        void disposeFlush()
        void disposeSync()
      }
    }, 'office-reporter: flush / sync 路由')
  })
}

export default { name, apply }
