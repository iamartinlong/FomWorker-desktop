/**
 * 控制面**编排器**（M2/B · O-P1 运行侧）：把 `office-ops` 的零件（锁 / 启动参数 / 环境 / 就绪 / 地址）
 * 组装成「**一 home 一活实例**」的多租户启动流程。
 *
 * 流程：`acquireLock(home)`（已占用则响亮抛，**绝不双起**）→ `spawn(buildWebArgs/buildWebEnv)` →
 * 轮询 `probe(port)` 到就绪 → 返回句柄（`stop()` 杀进程 + 放锁）；任何失败都**杀进程 + 放锁**再抛。
 *
 * 端口（`spawn`/`probe`/`acquireLock`/`sleep`/`now`）全部注入 ⇒ 逻辑可单测；真实现是 `node:child_process` + HTTP。
 */

import { acquireHomeLock, type HomeLock } from './lock.ts'
import { buildWebArgs, buildWebEnv, type LaunchPlan, type WebLaunchSpec } from './supervise.ts'

/** 已起的子进程最小面。 */
export interface SpawnedProcess {
  readonly pid: number
  kill(): void
}

/** 编排端口（可注入以单测）。 */
export interface SupervisorPorts {
  /** 抢占 home 锁（默认 `acquireHomeLock`；已占用抛 `HomeLockError`）。 */
  acquireLock?: (homeDir: string) => HomeLock
  /** 起一个数据面进程。 */
  spawn: (spec: WebLaunchSpec, args: readonly string[], env: NodeJS.ProcessEnv) => SpawnedProcess
  /** 探活：端口就绪返回 true。 */
  probe: (port: number) => Promise<boolean>
  /** 就绪超时（默认 180000ms）。 */
  readyTimeoutMs?: number
  /** 轮询间隔（默认 3000ms）。 */
  pollIntervalMs?: number
  /** 时钟 / 睡眠（默认真实）。 */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** 一个已起的租户句柄。 */
export interface TenantHandle {
  readonly tenantId: string
  readonly homeDir: string
  readonly pid: number
  /** 停进程 + 放锁（幂等）。 */
  stop(): void
}

/** 控制面编排器。 */
export interface Supervisor {
  start(plan: LaunchPlan): Promise<TenantHandle>
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 造编排器。
 * @param ports - 注入端口（`spawn`/`probe` 必填；其余有默认）。
 * @returns 编排器。
 */
export function createSupervisor(ports: SupervisorPorts): Supervisor {
  const acquireLock = ports.acquireLock ?? acquireHomeLock
  const now = ports.now ?? Date.now
  const sleep = ports.sleep ?? defaultSleep
  const readyTimeoutMs = ports.readyTimeoutMs ?? 180_000
  const pollIntervalMs = ports.pollIntervalMs ?? 3000

  const waitReady = async (port: number): Promise<boolean> => {
    const deadline = now() + readyTimeoutMs
    while (now() < deadline) {
      if (await ports.probe(port)) return true
      await sleep(pollIntervalMs)
    }
    return false
  }

  return {
    async start(plan) {
      const homeDir = plan.spec.homeDir
      const lock = acquireLock(homeDir) // 已占用 ⇒ 抛（一 home 一活实例）
      let child: SpawnedProcess | undefined
      let stopped = false
      const stop = (): void => {
        if (stopped) return
        stopped = true
        try { child?.kill() } catch { /* 已退出 */ }
        lock.release()
      }
      try {
        child = ports.spawn(plan.spec, buildWebArgs(plan.spec), buildWebEnv(plan.spec))
        if (!(await waitReady(plan.spec.port))) throw new Error(`租户 ${plan.tenantId} 就绪超时`)
        return { tenantId: plan.tenantId, homeDir, pid: child.pid, stop }
      } catch (error) {
        stop()
        throw error
      }
    },
  }
}
