/**
 * **审批托管的竞速仲裁**（纯逻辑，便于单测）。
 *
 * 口径（实施计划 D-1）：
 * - 本地面板照常出卡；**离开电脑**（idle/锁屏）⇒ **立即**转发到 IM；
 * - 否则**等 `forwardAfterMs`**（缺省 20s），无应答才转发；
 * - 转发后**本地与远程同时有效，先答先赢**；本地后来先答 ⇒ 通知平台撤回那条待批；
 * - 远程一直不回 ⇒ `cancelled`（不要默默挂死）。
 */

/** 内核的审批结论（与 `@deepseek-ai/dsh-user-approval` 同集）。 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** 竞速配置。 */
export interface RaceConfig {
  /** 本地面板无应答多久后转发（毫秒）。 */
  readonly forwardAfterMs: number
  /** 远程无应答多久放弃（毫秒）。 */
  readonly remoteTimeoutMs: number
  /** 是否「离开」（idle ≥ 阈值或锁屏）⇒ 不等超时立即转发。 */
  readonly away: boolean
}

/** 竞速依赖（全部可注入，便于单测）。 */
export interface RaceDeps<T> {
  /** 本地面板（内核审批面板）的裁决。 */
  readonly local: Promise<T>
  /** 推 IM 并等回复；连不上等实现细节由调用方兜。 */
  readonly startRemote: () => Promise<T>
  /** 计时器（单测注入）。 */
  readonly sleep: (ms: number) => Promise<void>
  /** 推不出去时的结论（缺省 `unavailable`）。 */
  readonly sentFailure?: T
  /** 远程等太久时的结论（缺省 `cancelled`）。 */
  readonly remoteTimeout?: T
  /** 本地在转发之后才答（远程那条作废）——调用方据此通知平台撤回。 */
  readonly onLocalWonAfterPush?: () => void
  /** 本地这条是不是「没有本地面板/直接失效」（如 `unavailable`）⇒ 视为没人答，继续走远程。 */
  readonly isLocalUnavailable?: (value: T) => boolean
}

/**
 * 跑一次竞速：先等本地（或离开即转），再本地/远程先到先赢。
 * @param deps 本地面板 / 远程通道 / 计时器
 * @param config 超时与离开
 * @returns 先到的结论
 */
export async function raceApproval<T>(deps: RaceDeps<T>, config: RaceConfig): Promise<T> {
  if (!config.away) {
    // 本地先到 vs 超时：用标签区分，避免 `Promise.race` 把 `void` 混进结果类型。
    const first = await Promise.race([
      deps.local.then((value) => ({ kind: 'local' as const, value })),
      deps.sleep(Math.max(0, config.forwardAfterMs)).then(() => ({ kind: 'timeout' as const })),
    ])
    if (first.kind === 'local' && !(deps.isLocalUnavailable?.(first.value) ?? false)) return first.value
  }

  // 本地没答（或已离开）⇒ 推远程，本地/远程先到先赢。
  const remote = Promise.race([
    deps.startRemote().catch(() => deps.sentFailure ?? deps.remoteTimeout ?? (undefined as T)),
    deps.sleep(Math.max(0, config.remoteTimeoutMs)).then(() => deps.remoteTimeout ?? (undefined as T)),
  ])
  // 本地若「直接失效」（没有本地面板）就不该赢第二局：映射成永不落地，等远程或超时。
  const localArm = deps.local.then((value) =>
    deps.isLocalUnavailable?.(value) === true
      ? new Promise<{ from: 'local'; value: T }>(() => {})
      : { from: 'local' as const, value },
  )
  const winner = await Promise.race([
    localArm,
    remote.then((value) => ({ from: 'remote' as const, value })),
  ])
  if (winner.from === 'local') deps.onLocalWonAfterPush?.()
  return winner.value
}
