/**
 * `office-meter` 插件壳（M2/A2 · 平台层 P0 / 成本 C-P0）：把用量采集/聚合以只读服务（`officeMeter`）挂到 context。
 * 控制面/观测读它出「每租户每日 token」表。
 *
 * 无 `inject`、无 `Config`（读哪个 home 由调用方给路径）。
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { collectSessionsUsage, type UsageReadReport } from './reader.ts'
import { mergeByDay, type SessionUsage, type UsageSummary } from './usage.ts'

export * from './usage.ts'
export * from './reader.ts'

/** 用量服务面。 */
export interface OfficeMeter {
  /** 采集一个 `$DSH_HOME`（内部读其 `sessions/`）。 */
  collect(homeDir: string): UsageReadReport
  /** 采集多个 `$DSH_HOME` 并合并。 */
  collectMany(homeDirs: readonly string[]): UsageReadReport
  /** 各会话按天用量合并成一张「日 → 汇总」表。 */
  byDay(sessions: readonly SessionUsage[]): Record<string, UsageSummary>
}

export const name = 'office-meter'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 会话用量采集/聚合（只读）。由本插件提供。 */
    officeMeter: OfficeMeter
  }
}

/** 造用量服务（纯封装，便于单测直接调）。 */
export function createMeterService(): OfficeMeter {
  return {
    collect: (homeDir) => collectSessionsUsage(join(homeDir, 'sessions')),
    collectMany: (homeDirs) => {
      const sessions: SessionUsage[] = []
      let files = 0
      let badLines = 0
      for (const home of homeDirs) {
        const report = collectSessionsUsage(join(home, 'sessions'))
        sessions.push(...report.sessions)
        files += report.files
        badLines += report.badLines
      }
      return { sessions, files, badLines }
    },
    byDay: (sessions) => mergeByDay(sessions),
  }
}

/**
 * 把用量服务暴露为 context 服务。
 * @param ctx - 插件上下文。
 */
export function apply(ctx: Context): void {
  const service = createMeterService()
  ctx.effect(() => ctx.reflect.provide('officeMeter', service))
}

export default { name, apply }
