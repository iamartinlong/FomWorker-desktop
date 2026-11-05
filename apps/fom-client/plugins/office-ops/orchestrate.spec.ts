import { describe, expect, it, vi } from 'vitest'
import { createSupervisor, type SpawnedProcess } from './orchestrate.ts'
import { HomeLockError, type HomeLock } from './lock.ts'

/** 内存锁端口。 */
function lockPort(): { acquireLock: (home: string) => HomeLock; held: Set<string> } {
  const held = new Set<string>()
  return {
    held,
    acquireLock: (home) => {
      if (held.has(home)) throw new HomeLockError(home)
      held.add(home)
      return { path: home, release: () => { held.delete(home) } }
    },
  }
}

const plan = (tenantId: string, homeDir: string, port: number) => ({
  tenantId,
  spec: { homeDir, port },
})

describe('office-ops · 编排器（O-P1）', () => {
  it('成功：锁→spawn→就绪→句柄；stop 杀进程并放锁', async () => {
    const { acquireLock, held } = lockPort()
    const killed: number[] = []
    const spawn = vi.fn((): SpawnedProcess => ({ pid: 111, kill: () => killed.push(111) }))
    const ready = createSupervisor({ acquireLock, spawn, probe: async () => true })

    const handle = await ready.start(plan('t1', 'C:/t1', 4000))
    expect(handle.pid).toBe(111)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(held.has('C:/t1')).toBe(true)

    handle.stop()
    expect(killed).toEqual([111])
    expect(held.has('C:/t1')).toBe(false)
    handle.stop() // 幂等
    expect(killed).toEqual([111])
  })

  it('同 home 第二次起 ⇒ HomeLockError（一 home 一活实例），且不 spawn', async () => {
    const { acquireLock, held } = lockPort()
    held.add('C:/t1') // 预先占用
    const spawn = vi.fn((): SpawnedProcess => ({ pid: 1, kill: () => {} }))
    const sup = createSupervisor({ acquireLock, spawn, probe: async () => true })
    await expect(sup.start(plan('t1', 'C:/t1', 4000))).rejects.toBeInstanceOf(HomeLockError)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('就绪超时 ⇒ 抛 + 杀进程 + 放锁', async () => {
    const { acquireLock, held } = lockPort()
    const killed: number[] = []
    const spawn = (): SpawnedProcess => ({ pid: 7, kill: () => killed.push(7) })
    let clock = 0
    const sup = createSupervisor({
      acquireLock, spawn, probe: async () => false,
      readyTimeoutMs: 100, pollIntervalMs: 10,
      now: () => clock, sleep: async (ms) => { clock += ms },
    })
    await expect(sup.start(plan('t1', 'C:/t1', 4000))).rejects.toThrow(/超时/)
    expect(killed).toEqual([7])
    expect(held.has('C:/t1')).toBe(false)
  })

  it('不同 home 各自可起', async () => {
    const { acquireLock, held } = lockPort()
    const sup = createSupervisor({ acquireLock, spawn: () => ({ pid: 1, kill: () => {} }), probe: async () => true })
    const a = await sup.start(plan('t1', 'C:/t1', 4000))
    const b = await sup.start(plan('t2', 'C:/t2', 4001))
    expect(a.pid).toBe(1)
    expect(b.pid).toBe(1)
    expect(held.size).toBe(2)
  })
})
