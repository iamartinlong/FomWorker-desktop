import { describe, expect, it, vi } from 'vitest'
import { raceApproval, type ApprovalOutcome } from './approval-race.ts'

/** 可控计时器：`fire(ms)` 触发对应时长的 sleep。 */
function fakeSleep() {
  const pending: Array<{ ms: number; resolve: () => void }> = []
  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      pending.push({ ms, resolve })
    })
  const fire = (ms: number): void => {
    const index = pending.findIndex((item) => item.ms === ms)
    if (index >= 0) pending.splice(index, 1)[0]?.resolve()
  }
  return { sleep, fire }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const CONFIG = { forwardAfterMs: 20_000, remoteTimeoutMs: 600_000, away: false }

describe('raceApproval（本地 vs IM，先到先赢）', () => {
  it('没离开且本地先答 ⇒ 用本地，且不推远程', async () => {
    const { sleep } = fakeSleep()
    const startRemote = vi.fn(async () => 'rejected' as ApprovalOutcome)
    const outcome = await raceApproval(
      { local: Promise.resolve('allowed-once' as ApprovalOutcome), startRemote, sleep },
      CONFIG,
    )
    expect(outcome).toBe('allowed-once')
    expect(startRemote).not.toHaveBeenCalled()
  })

  it('没离开、本地 20s 无应答 ⇒ 推远程，远程先答者赢', async () => {
    const { sleep, fire } = fakeSleep()
    const startRemote = vi.fn(async () => 'rejected' as ApprovalOutcome)
    const run = raceApproval({ local: new Promise<ApprovalOutcome>(() => {}), startRemote, sleep }, CONFIG)
    fire(20_000)
    await expect(run).resolves.toBe('rejected')
    expect(startRemote).toHaveBeenCalledTimes(1)
  })

  it('已离开 ⇒ 不等 20s，直接推远程', async () => {
    const { sleep } = fakeSleep()
    const startRemote = vi.fn(async () => 'allowed-once' as ApprovalOutcome)
    const outcome = await raceApproval(
      { local: new Promise<ApprovalOutcome>(() => {}), startRemote, sleep },
      { ...CONFIG, away: true },
    )
    expect(outcome).toBe('allowed-once')
    expect(startRemote).toHaveBeenCalledTimes(1)
  })

  it('转发之后本地才答 ⇒ 用本地，并回调「远程作废」', async () => {
    const { sleep, fire } = fakeSleep()
    const local = deferred<ApprovalOutcome>()
    const onLocalWonAfterPush = vi.fn()
    const run = raceApproval(
      {
        local: local.promise,
        startRemote: () => new Promise<ApprovalOutcome>(() => {}),
        sleep,
        onLocalWonAfterPush,
      },
      CONFIG,
    )
    fire(20_000)
    await Promise.resolve()
    local.resolve('allowed-once')
    await expect(run).resolves.toBe('allowed-once')
    expect(onLocalWonAfterPush).toHaveBeenCalledTimes(1)
  })

  it('远程一直不回 ⇒ 到点给 cancelled（不挂死）', async () => {
    const { sleep, fire } = fakeSleep()
    const run = raceApproval(
      {
        local: new Promise<ApprovalOutcome>(() => {}),
        startRemote: () => new Promise<ApprovalOutcome>(() => {}),
        sleep,
        remoteTimeout: 'cancelled',
      },
      CONFIG,
    )
    fire(20_000)
    await new Promise((resolve) => setTimeout(resolve, 0))
    fire(600_000)
    await expect(run).resolves.toBe('cancelled')
  })


  it('本地直接失效（unavailable）⇒ 视为没人答，走远程', async () => {
    const { sleep } = fakeSleep()
    const startRemote = vi.fn(async () => 'allowed-once' as ApprovalOutcome)
    const outcome = await raceApproval(
      {
        local: Promise.resolve('unavailable' as ApprovalOutcome),
        startRemote,
        sleep,
        isLocalUnavailable: (value) => value === 'unavailable',
      },
      CONFIG,
    )
    expect(outcome).toBe('allowed-once')
    expect(startRemote).toHaveBeenCalledTimes(1)
  })
  it('推不出去（通道未连）⇒ unavailable，且本地后答仍可赢', async () => {
    const { sleep, fire } = fakeSleep()
    const local = deferred<ApprovalOutcome>()
    const run = raceApproval(
      {
        local: local.promise,
        startRemote: () => Promise.resolve('unavailable' as ApprovalOutcome),
        sleep,
        sentFailure: 'unavailable',
      },
      CONFIG,
    )
    fire(20_000)
    await expect(run).resolves.toBe('unavailable')
  })
})
