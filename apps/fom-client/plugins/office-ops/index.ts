/**
 * `office-ops` 插件壳（M2/B · O-P0）：把运维辅助（备份等）以只读/文件级服务（`officeOps`）挂到 context。
 * 控制面/运维脚本消费它。
 */

import type { Context } from '@deepseek-ai/cordis'
import { BACKUP_ENTRIES, backupHome, existingBackupEntries } from './backup.ts'
import { acquireHomeLock, type HomeLock } from './lock.ts'

export * from './backup.ts'
export * from './supervise.ts'
export * from './lock.ts'
export * from './orchestrate.ts'

/** 运维服务面。 */
export interface OfficeOps {
  readonly backupEntries: readonly string[]
  existingBackupEntries(homeDir: string): string[]
  backupHome(homeDir: string, destDir: string): string[]
  /** 抢占一个 home 的活实例锁（一 home 一活实例）。 */
  acquireHomeLock(homeDir: string): HomeLock
}

export const name = 'office-ops'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 运维辅助（备份等）。由本插件提供。 */
    officeOps: OfficeOps
  }
}

/**
 * 把运维服务暴露为 context 服务。
 * @param ctx - 插件上下文。
 */
export function apply(ctx: Context): void {
  const service: OfficeOps = { backupEntries: BACKUP_ENTRIES, existingBackupEntries, backupHome, acquireHomeLock }
  ctx.effect(() => ctx.reflect.provide('officeOps', service))
}

export default { name, apply }
