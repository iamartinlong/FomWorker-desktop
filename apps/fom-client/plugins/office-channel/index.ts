/**
 * `office-channel` —— **IM 中继的客户端接收**（`platform → client` 那一半，IM 链路的最后一环）。
 *
 * 它常连平台的 `GET /api/ws`（与上报、下发同一条通道，见 `ws/client-platform.schema.json`）：
 * - 收到 **`im.relay`** ⇒ 折成「投给哪个会话 + 说什么」（`relay.ts`）⇒ **建/续本地会话**并把正文投进去；
 * - 收到 `ack` ⇒ 记一行；收到 `quota.downlink` / `catalog.downlink` ⇒ **目前只留声**（消费它们属 C5b 客户端半，后置）。
 *
 * 断线**自动重连**（指数退避封顶）+ 定期 `heartbeat`（顺带把设备探活的 `last_seen_at` 刷新，`deviceId` 缺省 `desktop-<主机名>`）。
 * 未配 `platformUrl`（或 `enabled: false`）⇒ **休眠**（与 `office-feishu` 同一取向：产品包里安静地不在）。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { relayMessage, type RelayMessage } from './relay.ts'
import { ImReplyCollector } from './reply.ts'

export * from './relay.ts'
export * from './reply.ts'

/** WebSocket 最小面（避免依赖具体实现；测试可注入）。 */
export interface SocketLike {
  send(data: string): void
  close(): void
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event?: { data?: unknown }) => void,
    options?: { once?: boolean },
  ): void
}

/** 会话解析/创建服务的最小面（内核 `agents`）。 */
interface AgentsLike {
  create?: (options: {
    sessionId: unknown
    agentOptions?: { provider: string; model: string }
    meta?: { cwd?: string }
  }) => Promise<{ agent?: { followup(message: unknown): void } }>
  /** 取活着的 agent（同步；内核 `ensureSession` 也用它认领已有会话）。 */
  get?: (sessionId: unknown) => { followup(message: unknown): void } | undefined
}

/** 缺省模型（内核 `agentDefaultModel`）：`agents.create` 要 provider/model。 */
interface AgentDefaultsLike {
  currentSelection?: () => { provider: string; model: string }
}

export interface OfficeChannelConfig {
  /** 平台基址（`http(s)://host:port`）；空 ⇒ 休眠。 */
  platformUrl: string
  /** 平台令牌的凭据 ref（与登录/上报同一名）。 */
  tokenRef: string
  /** 总开关（缺省 true；与 `platformUrl` 是两件事，便于临时关掉常连）。 */
  enabled: boolean
  /** 心跳间隔（毫秒；0 ＝ 不发）。 */
  heartbeatMs: number
  /** 重连退避基数（毫秒；每次翻倍、封顶 60 秒）。 */
  reconnectBaseMs: number
  /** 「等登录」的重试间隔（毫秒；固定值，不走退避）。 */
  loginRetryMs: number
  /** 设备标识（心跳用；空 ⇒ `desktop-<主机名>`）。平台按 `device_id` 记探活。 */
  deviceId: string
}

const Config: z<OfficeChannelConfig> = z.object({
  platformUrl: z.string().default(''),
  tokenRef: z.string().default('FOM_PLATFORM_TOKEN'),
  enabled: z.boolean().default(true),
  heartbeatMs: z.number().default(30_000),
  reconnectBaseMs: z.number().default(5_000),
  loginRetryMs: z.number().default(5_000),
  deviceId: z.string().default(''),
})

export const name = 'office-channel'

/**
 * 常连要的三项内核服务（缺一个就不装 —— 装了也投不进去）。
 * ⚠️ **必须写在这里**：cordis 对**未声明**的服务属性访问会直接抛
 * `cannot get property "<name>" without inject`（2026-10-17 真环境实测）。
 */
export const inject = ['agents', 'agentDefaultModel']

/** 平台基址 → WS 地址（`http→ws`、`https→wss`，路径固定 `/api/ws`）。 */
export function toWsUrl(platformUrl: string): string {
  const base = platformUrl.replace(/\/+$/u, '').replace(/^http/u, 'ws')
  return `${base}/api/ws`
}

function defaultSocket(url: string): SocketLike {
  const Impl = (globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket
  if (Impl === undefined) throw new Error('office-channel: 无全局 WebSocket')
  return new Impl(url)
}

export function apply(
  ctx: Context,
  config: OfficeChannelConfig,
  deps: { createSocket?: (url: string) => SocketLike } = {},
): void {
  const logger = ctx.logger('office-channel')
  const createSocket = deps.createSocket ?? defaultSocket
  /**
   * 运维可见性：真 `web` 进程里插件 logger **既不到 stdout 也不到 startup 日志**（M1 第 8 步实测），
   * 而「IM 通道连不上平台」是必须让现场听见的事实（否则消息静默不落会话）⇒ 关键状态**同时**写
   * **stderr** 与 **`$DSH_HOME/logs/office-channel.log`**：前者给前台/CI，后者给「stderr 被吞」的场合
   * （2026-10-17 真环境里同一个构建的 stderr 行**时有时无**，只能靠落文件才问得清）。
   * 只在**连接状态与失败**这些低频点写，逐帧消息不写。
   */
  const report = (message: string): void => {
    const line = `[office-channel] ${new Date().toISOString()} ${message}\n`
    process.stderr.write(line)
    try {
      const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
        ? process.env.DSH_HOME
        : join(homedir(), '.dsh')
      const dir = join(home, 'logs')
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, 'office-channel.log'), line)
    } catch {
      // 落盘失败不影响主流程（stderr 那一份已经写了）。
    }
  }

  if (!config.enabled || config.platformUrl === '') {
    report('休眠：未配 platformUrl 或 enabled=false')
    return
  }

  /** 会话键 → 本地会话 id（同一 IM 会话续投同一个本地会话）。内存即可：重启后由第一条消息重建。 */
  const sessions = new Map<string, string>()
  /** 回消息用：本机由 IM 中继建起来的会话 → 从哪儿回（chatId）。 */
  const relayed = new Map<string, { channel: string; openId: string; chatId: string; messageId: string }>()
  const replyCollector = new ImReplyCollector()
  /** 上行发送口（连上后可用；断开即清）。 */
  let sendUpstream: ((frame: unknown) => void) | undefined
  /** 其它插件注册的下行处理器（按帧 `type`）。 */
  const downlinkHandlers = new Map<string, Set<(frame: Record<string, unknown>) => void>>()
  /** 回消息正文上限（飞书单条文本上限以内，超了截断并标注）。 */
  const MAX_REPLY_CHARS = 3500
  const target = toWsUrl(config.platformUrl)
  const deviceId = config.deviceId === '' ? `desktop-${hostname()}` : config.deviceId

  const readToken = async (): Promise<string> => {
    const credentials = ctx.get('credentials') as { resolve?: (ref: string) => Promise<{ value: string } | undefined> } | undefined
    return (await credentials?.resolve?.(config.tokenRef))?.value ?? ''
  }

  /**
   * 给会话类调用加**超时**：`sessionController.create` / `agents.resolveAgent` 在内核里是长链路
   * （建 agent / 装配预设 / 解析模型），真环境里出现过**既不返回也不抛**的情形（2026-10-17）。
   * 超时把「静默挂死」变成一句点名阶段的话，且**不永远占着消息**。
   */
  const withTimeout = async <T>(label: string, promise: Promise<T>, ms = 10_000): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms 未返回）`)), ms)
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  /** 把一条中继消息投进本地会话（第一条建，后续续投同一个）。 */
  const deliverRelay = async (message: RelayMessage): Promise<void> => {
    // ⚠️ `agents`/`agentDefaultModel` 是 **声明式注入**（见文件尾 `inject`）⇒ 按内核约定要用
    // `ctx.<name>` 属性代理；`ctx.get('<name>')` 走全局服务表，对声明式注入**可能看不见**
    // （2026-10-17 真链路上实测：`ctx.get('agents')` 是 undefined，而插件明明加载成功）。
    //
    // ⚠️ **不要调 `ctx.sessionController.create`**：那是 **Typert 远程方法**，本地直调会等一个
    // 永远不来的「远程应答」⇒ 表现为**挂起**（真环境里 create 既不返回也不抛，正是这条）。
    // 内核自己建会话走的是 `agents.create`（`session-controller/src/agent.ts` 的 `createOrAdopt`）。
    const declared = ctx as unknown as { agents?: AgentsLike; agentDefaultModel?: AgentDefaultsLike }
    const agents = declared.agents ?? (ctx.get('agents') as AgentsLike | undefined)
    const defaults = declared.agentDefaultModel ?? (ctx.get('agentDefaultModel') as AgentDefaultsLike | undefined)
    if (agents?.create === undefined) {
      report(`IM 中继到了，但会话服务不齐 ⇒ 丢弃（agents/create=${typeof agents?.create}）`)
      return
    }

    const existing = sessions.get(message.chatKey)
    let sessionId: string
    let agent: { followup(message: unknown): void } | undefined

    try {
      if (existing === undefined) {
        const selection = defaults?.currentSelection?.()
        if (selection === undefined) {
          report('IM 中继到了，但没有缺省模型（agentDefaultModel 取不到）⇒ 丢弃')
          return
        }
        sessionId = `session-${randomUUID()}`
        const handle = await withTimeout('建会话（agents.create）', agents.create({
          sessionId,
          agentOptions: selection,
          meta: { cwd: process.cwd() },
        }))
        agent = handle.agent
        if (agent !== undefined) {
          sessions.set(message.chatKey, sessionId)
          report(`IM 会话已建：${message.chatKey} → ${sessionId}`)
        }
      } else {
        sessionId = existing
        // 续投：取活着的 agent（同步）；重启后内存里没有会话键，会走上面的「新建」分支。
        agent = agents.get?.(SessionId(sessionId))
      }
    } catch (error) {
      report(`IM 会话准备失败：${String((error as Error)?.message ?? error)}`)
      return
    }

    if (agent === undefined) {
      report(`IM 消息投递失败：会话 ${sessionId} 不可用`)
      return
    }

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: message.text }],
      source: { kind: 'user' },
    }))
    relayed.set(sessionId, {
      channel: message.channel,
      openId: message.openId,
      chatId: message.chatId,
      messageId: message.messageId,
    })
    report(`IM 消息已投进会话 ${sessionId}（${message.channel}/${message.openId}）`)
  }

  const dispatch = async (raw: string): Promise<void> => {
    let frame: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
      frame = parsed as Record<string, unknown>
    } catch {
      logger.warn('IM 通道收到无法解析的帧，已忽略')
      return
    }

    // 先给「其它插件注册的下行消费方」一次机会（`office-delegate` 的 `approval.action` 等）；
    // `office-channel` 自己不认识它们的类型，不抢。
    const handlers = downlinkHandlers.get(String(frame.type))
    if (handlers !== undefined) {
      for (const handler of [...handlers]) {
        try {
          handler(frame)
        } catch (error) {
          logger.warn(`下行处理器出错（${String(frame.type)}）：${String((error as Error)?.message ?? error)}`)
        }
      }
    }

    switch (frame.type) {
      case 'im.relay': {
        const message = relayMessage(frame)
        if (message === undefined) {
          logger.warn('im.relay 帧形状不对（缺 channel/openId/text），已忽略')
          return
        }
        await deliverRelay(message)
        break
      }
      case 'ack':
        // 我们这一侧不发上行（上报走 HTTP），收到 ack 只留声。
        logger.info(`收到 ack：${String(frame.ref)}`)
        break
      case 'quota.downlink':
      case 'catalog.downlink':
      case 'config.downlink':
      case 'subscription.downlink':
        // 消费它们属 C5b 客户端半（后置）；现在只留声，别让「静默丢弃」看起来像没收到。
        logger.info(`收到 ${String(frame.type)}（暂未消费，见 IM对接现状与计划 §4 IM-5 待做②）`)
        break
      default:
        logger.warn(`IM 通道收到未知消息类型 ${String(frame.type)}，已忽略`)
        break
    }
  }

  // 回消息：IM 中继建的会话答完（`turn/end`）⇒ 把最后一条助手正文经通道发回 IM
  // （平台侧再调飞书 `im/v1/messages`；平台只在「最近中继过这个会话」时才放行）。
  ctx.effect(() => {
    const off = ctx.on('session/event', (session: unknown, event: unknown) => {
      const sessionId = String((session as { id?: unknown } | undefined)?.id ?? '')
      const type = String((event as { type?: unknown } | undefined)?.type ?? '')
      const text = replyCollector.onEvent(sessionId, type, (event as { data?: unknown } | undefined)?.data)
      if (text === undefined) return
      const route = relayed.get(sessionId)
      if (route === undefined) return
      if (sendUpstream === undefined) {
        report(`IM 回复未发出：通道未连（${sessionId}）`)
        return
      }
      const body = text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)}…（已截断）` : text
      sendUpstream({
        type: 'im.reply',
        channel: route.channel,
        chatId: route.chatId,
        messageId: route.messageId,
        text: body,
      })
      report(`IM 回复已发回（${route.channel}/${route.chatId}，${body.length} 字）`)
    })
    return () => off()
  }, 'office-channel: 回消息（turn/end）')

  // 把「通道」以标记服务交给别的插件（`office-delegate` 用它发控制帧 / 收 `approval.action`）。
  // 标记在装配时就有：未连上时 `send` 返回 false（调用方据此退回 `unavailable`），不会静默丢。
  ctx.effect(() => ctx.reflect.provide('officeImChannel', {
    send: (frame: unknown): boolean => {
      if (sendUpstream === undefined) return false
      sendUpstream(frame)
      return true
    },
    onDownlink: (type: string, handler: (frame: Record<string, unknown>) => void): (() => void) => {
      const set = downlinkHandlers.get(type) ?? new Set()
      set.add(handler)
      downlinkHandlers.set(type, set)
      return () => {
        set.delete(handler)
      }
    },
  }), 'office-channel: 对外提供 officeImChannel（控制帧收发）')

  ctx.effect(() => {
    let socket: SocketLike | null = null
    let heartbeat: ReturnType<typeof setInterval> | null = null
    let reconnect: ReturnType<typeof setTimeout> | null = null
    let attempt = 0
    let stopped = false

    const cleanup = (): void => {
      sendUpstream = undefined
      if (heartbeat !== null) { clearInterval(heartbeat); heartbeat = null }
      if (reconnect !== null) { clearTimeout(reconnect); reconnect = null }
      const current = socket
      socket = null
      try { current?.close() } catch { /* 关不上忽略 */ }
    }

    const scheduleReconnect = (): void => {
      if (stopped || reconnect !== null) return
      const delay = Math.min(config.reconnectBaseMs * 2 ** attempt, 60_000)
      attempt += 1
      report(`${Math.round(delay / 1000)} 秒后重连（第 ${attempt} 次）`)
      reconnect = setTimeout(() => {
        reconnect = null
        void connect()
      }, delay)
    }

    const connect = async (): Promise<void> => {
      if (stopped) return
      let token = ''
      try {
        token = await readToken()
      } catch (error) {
        // 读凭据失败不该**静默打断**重连循环（之前就是这里把循环弄死的）——按「没令牌」处理，等下次重试。
        report(`读平台令牌失败：${String((error as Error)?.message ?? error)}`)
      }

      if (token === '') {
        // 没登录：**固定短间隔**再来（登录后令牌会出现在凭据里，最多等 loginRetryMs）。
        // ⚠️ 不走指数退避：缺的是「用户登录」这个外部事件，退避涨到 60s 只会让登录后白等
        // （2026-10-18 排查结论：曾被误判成「重连循环终止」，实为退避太长 + 观察窗口太短）。
        report(`等登录（凭据里还没有平台令牌），${Math.round(config.loginRetryMs / 1000)}s 后重试`)
        if (stopped || reconnect !== null) return
        reconnect = setTimeout(() => {
          reconnect = null
          void connect()
        }, config.loginRetryMs)
        return
      }

      let ws: SocketLike
      try {
        ws = createSocket(`${target}?token=${encodeURIComponent(token)}`)
      } catch (error) {
        report(`起不来：${String((error as Error)?.message ?? error)}`)
        scheduleReconnect()
        return
      }
      socket = ws

      ws.addEventListener('open', () => {
        attempt = 0
        sendUpstream = (frame: unknown) => {
          try {
            ws.send(JSON.stringify(frame))
          } catch (error) {
            report(`上行发送失败：${String((error as Error)?.message ?? error)}`)
          }
        }
        report(`已连上平台 ${target}`)
        if (config.heartbeatMs > 0) {
          heartbeat = setInterval(() => {
            try { ws.send(JSON.stringify({ type: 'heartbeat', deviceId })) } catch { /* 断开由 close 事件兜 */ }
          }, config.heartbeatMs)
        }
      })

      ws.addEventListener('message', (event) => {
        const data = event?.data
        void dispatch(typeof data === 'string' ? data : String(data ?? '')).catch((error: unknown) => {
          report(`IM 通道处理消息出错：${String((error as Error)?.message ?? error)}`)
        })
      })

      ws.addEventListener('close', () => {
        if (stopped) return
        report('断开，准备重连')
        cleanup()
        scheduleReconnect()
      })

      ws.addEventListener('error', () => {
        // 具体的错在 close 里统一收场（error 之后通常紧跟 close）。
      })
    }

    void connect()

    return cleanup
  })
}

export default { name, inject, Config, apply }
