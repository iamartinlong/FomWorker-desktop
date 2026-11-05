/**
 * `office-audit` 插件壳（M2/E-P1 · 平台层 §4.1 审计）：把逐 `$DSH_HOME` 的审计采集/索引以只读服务
 * （`officeAudit`）挂到 context。控制面/观测读它出「可查可导出的审计索引」。
 *
 * 读法复用 `office-meter` 的 `readSessionLogs`（同一读取口径：zstd 解码 + JSONL 解析 + 取最高代）。
 * 无 `inject`、无 `Config`（读哪个 home 由调用方给路径）。
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { readSessionLogs } from '../office-meter/reader.ts'
import { collectAudit, type AuditEntry } from './audit.ts'
import { createAuditStore, type AuditStore } from './store.ts'

export * from './audit.ts'
export * from './store.ts'

/** 一个采集目标（租户 + 其 `$DSH_HOME`）。 */
export interface AuditTarget {
  readonly tenant: string
  readonly homeDir: string
}

/** 审计服务面（只读采集 + 造索引）。 */
export interface OfficeAudit {
  /** 采集一个 `$DSH_HOME`（内部读其 `sessions/`）为审计条目。 */
  collect(homeDir: string, tenant: string): AuditEntry[]
  /** 采集多个租户 home 并合并。 */
  collectMany(targets: readonly AuditTarget[]): AuditEntry[]
  /** 造一个新的空审计索引（调用方自行 `add`/`query`/`exportJsonl`）。 */
  createStore(): AuditStore
}

export const name = 'office-audit'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 审计采集/索引（只读）。由本插件提供。 */
    officeAudit: OfficeAudit
  }
}

/** 造审计服务（纯封装，便于单测直接调）。 */
export function createAuditService(): OfficeAudit {
  const collect = (homeDir: string, tenant: string): AuditEntry[] =>
    collectAudit(readSessionLogs(join(homeDir, 'sessions')), tenant)
  return {
    collect,
    collectMany: (targets) => targets.flatMap((target) => collect(target.homeDir, target.tenant)),
    createStore: () => createAuditStore(),
  }
}

/**
 * 把审计服务暴露为 context 服务。
 * @param ctx - 插件上下文。
 */
export function apply(ctx: Context): void {
  const service = createAuditService()
  ctx.effect(() => ctx.reflect.provide('officeAudit', service))
}

export default { name, apply }
