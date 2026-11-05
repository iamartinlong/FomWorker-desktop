/**
 * `office-delegate` —— **审批托管**（v1：文本）。
 *
 * 内核 `approval/request` 是 waterfall（`(req, next)`）：本插件 **prepend** 在最外层，
 * 拿住 `next()`（＝本地面板那条链）与「推 IM 等回复」赛跑 —— 先答先赢（见 `approval-race.ts`）。
 *
 * 触发口径（D-1）：离开电脑（idle ≥ `idleForwardMs` 或锁屏）**立即**转发；否则等
 * `forwardAfterMs`（缺省 20s）无应答才转发。远程等 `remoteTimeoutMs` 不回 ⇒ `cancelled`。
 *
 * 通道：复用 `office-channel` 提供的 `officeImChannel` 标记（`send` / `onDownlink`）——
 * **不自己开 WebSocket**（同一条常连，D-6 的设备角色在平台侧收口）。
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { raceApproval, type ApprovalOutcome } from './approval-race.ts'

export * from './approval-race.ts'

/** 插件的配置。 */
export const Config = z.object({
  /** 关掉 ⇒ 完全退回本地面板（托管不介入）。 */
  enabled: z.boolean().default(true),
  /** 本地面板无应答多久后转发（毫秒）。 */
  forwardAfterMs: z.number().default(20_000),
  /** 远程等多久不回就放弃（毫秒，缺省 10 分钟）。 */
  remoteTimeoutMs: z.number().default(600_000),
  /** idle 超过多久算「离开」（毫秒，缺省 5 分钟）⇒ 立即转发。 */
  idleForwardMs: z.number().default(300_000),
})

type DelegateConfig = Schemastery.TypeT<typeof Config>

interface ChannelLike {
  send(frame: unknown): boolean
  onDownlink(type: string, handler: (frame: Record<string, unknown>) => void): () => void
}

interface ApprovalRequestEventLike {
  readonly toolName: string
  readonly callId?: unknown
  readonly reason?: string
  readonly displayReason?: { readonly en: string; readonly [locale: string]: string }
  readonly signal?: AbortSignal
}

/** 离开判定：Electron 的 `powerMonitor`（桌面）；`dsh web` 里没有 ⇒ 只按超时。 */
function awayDetector(idleForwardMs: number): () => boolean {
  type PowerMonitorLike = { getSystemIdleTime?: () => number; getSystemIdleState?: (threshold: number) => string }
  let monitor: PowerMonitorLike | undefined
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { powerMonitor?: PowerMonitorLike }
    monitor = electron.powerMonitor
  } catch {
    monitor = undefined
  }

  return () => {
    if (monitor?.getSystemIdleState !== undefined) {
      try {
        if (monitor.getSystemIdleState(Math.round(idleForwardMs / 1000)) !== 'active') return true
      } catch {
        // 取不到就退回按秒数判断
      }
    }
    try {
      const idleSeconds = monitor?.getSystemIdleTime?.()
      return idleSeconds !== undefined && idleSeconds * 1000 >= idleForwardMs
    } catch {
      return false
    }
  }
}

function report(message: string): void {
  const line = `${new Date().toISOString()} [office-delegate] ${message}`
  process.stderr.write(line + '\n')
  try {
    appendFileSync(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'logs', 'office-delegate.log'), line + '\n')
  } catch {
    // 日志写不进去不影响托管（stderr 已有一份）。
  }
}

const truncate = (text: string, length: number): string => (text.length <= length ? text : `${text.slice(0, length)}…`)

/** 插件名。 */
export const name = 'office-delegate'

/** 依赖 `office-channel` 提供的通道标记。 */
export const inject = ['officeImChannel']

/**
 * 挂审批托管：把 `approval/request` 包一层竞速（本地 vs IM）。
 * @param ctx 插件上下文。
 * @param config 超时/开关。
 */
export function apply(ctx: Context, config: DelegateConfig): void {
  if (!config.enabled) {
    report('已关闭（enabled=false）⇒ 完全退回本地面板')
    return
  }

  const away = awayDetector(config.idleForwardMs)
  const channel = (): ChannelLike | undefined => ctx.get('officeImChannel') as ChannelLike | undefined

  const pushRemote = (req: ApprovalRequestEventLike, approvalId: string): Promise<ApprovalOutcome> => {
    const target = channel()
    if (target === undefined) return Promise.resolve('unavailable')

    const answer = new Promise<ApprovalOutcome>((resolve) => {
      let settled = false
      const finish = (value: ApprovalOutcome): void => {
        if (settled) return
        settled = true
        off()
        resolve(value)
      }
      const off = target.onDownlink('approval.action', (frame) => {
        if (String(frame.approvalId) !== approvalId) return
        const decision = String(frame.decision)
        finish(decision === 'rejected' ? 'rejected' : decision === 'allowed-once' ? 'allowed-once' : 'cancelled')
      })
      req.signal?.addEventListener('abort', () => finish('cancelled'))
    })

    const summary = truncate(req.reason ?? req.displayReason?.en ?? '', 200)
    const sent = target.send({
      type: 'approval.request',
      approvalId,
      toolName: req.toolName,
      summary,
    })
    if (!sent) return Promise.resolve('unavailable')
    report(`已转发到 IM（approvalId=${approvalId}，tool=${req.toolName}）`)
    return answer
  }

  ctx.effect(() => {
    const off = ctx.on(
      'approval/request',
      (req: ApprovalRequestEventLike, next: () => Promise<ApprovalOutcome>) => {
        const local = next().catch((): ApprovalOutcome => 'unavailable')
        const approvalId = randomUUID()
        const isAway = away()
        if (isAway) report(`检测到离开（idle/锁屏）⇒ 立即转发（${req.toolName}）`)
        return raceApproval(
          {
            local,
            startRemote: () => pushRemote(req, approvalId),
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            sentFailure: 'unavailable',
            isLocalUnavailable: (value) => value === 'unavailable',
            remoteTimeout: 'cancelled',
            onLocalWonAfterPush: () => {
              report(`本地先答（远程作废，approvalId=${approvalId}）`)
              channel()?.send({ type: 'approval.answered', approvalId })
            },
          },
          { forwardAfterMs: config.forwardAfterMs, remoteTimeoutMs: config.remoteTimeoutMs, away: isAway },
        )
      },
      { prepend: true },
    )
    return () => {
      off()
    }
  }, 'office-delegate: 审批托管（本地 vs IM 竞速）')

  report(`已启用（forwardAfterMs=${config.forwardAfterMs}, remoteTimeoutMs=${config.remoteTimeoutMs}, idleForwardMs=${config.idleForwardMs}）`)
}

export default { name, inject, Config, apply }
