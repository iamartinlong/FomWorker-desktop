/**
 * Deep Dream 蒸馏的对账台账（设计 §3.5「对账」、§7 第 5 步）。
 *
 * 它回答三个问题：这一夜跑没跑、写了/撤了几个文件、被守卫拦下几次。测试**轮询这张表**
 * 而不是轮询文件系统 —— 领域的写链是异步的（M1 §8 第 3 步那条坑在这里同样成立），
 * 而 `office_memory_run` 的一次落账是「这一夜确实收尾了」的权威回执。
 *
 * 域名/表名受 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/` 约束（不接受连字符），per-record 主键
 * 受 `^[a-zA-Z0-9_-]+$` 约束（接受连字符/下划线、**不接受冒号**）—— 与审批台账同一套落地约束。
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'

/**
 * 一次蒸馏的结局。
 * - `no-op`：没有新日级文件，一条不写（DM8 幂等命中）—— 这是**成功**，不是没跑。
 * - `distilled`：重排了索引（可能伴随新增/归档）。
 */
export const distillOutcomes = ['no-op', 'distilled'] as const
export type DistillOutcome = typeof distillOutcomes[number]

const runSchema = z.object({
  /** per-record 主键（不能含冒号）。由 `startedAt` 派生的稳定串，重启重投同一次仍是同一行。 */
  runId: z.string(),
  startedAt: z.number(),
  finishedAt: z.number(),
  outcome: z.enum(distillOutcomes),
  /** 本轮从日级提炼并成功落盘的新条目数。 */
  promoted: z.number().int(),
  /** 本轮淘汰（移进 archived/）的条目数。 */
  archived: z.number().int(),
  /** 重写后的索引行数（常驻段的成本，ME1 的观测点）。 */
  indexLines: z.number().int(),
  /** 因命中手改判定而**跳过淘汰**的条目数（ME2 的观测点：人编辑过的不被动）。 */
  guardedSkips: z.number().int(),
  /** 本轮之前读到的水位线日；`null` = 没有水位线（首次或丢失）。 */
  watermarkFrom: z.string().nullable(),
  /** 本轮之后写入的水位线日；`no-op` 时保持原值。 */
  watermarkTo: z.string(),
})
export type MemoryRunRecord = z.infer<typeof runSchema>

export const memoryRunDomain = defineDomain({
  name: 'office_memory_run',
  version: 1,
  layout: 'per-record',
  tables: {
    runs: domainTable<string, MemoryRunRecord>(runSchema),
  },
})

export type MemoryRunDomain = Domain<typeof memoryRunDomain>

/**
 * 由开始时刻派生一个稳定的 run 主键。
 *
 * 用 `startedAt` 而不是 `randomUUID`：`schedule` 的投递是 at-least-once（MF4），同一次夜间蒸馏
 * 若崩溃后重投，拿到的仍是同一个 `startedAt` ⇒ 同一个 runId ⇒ 覆盖写而不是多记一行假账。
 * 真正的「不同夜」必然 `startedAt` 不同，所以这个主键既是幂等键又是按时间的排序键。
 */
export function runIdOf(startedAt: number): string {
  return `run-${startedAt}`
}

export class MemoryRunLedger {
  constructor(private readonly domain: MemoryRunDomain) {}

  private get runs() {
    return this.domain.table('runs')
  }

  /** 落一次蒸馏的对账行（覆盖写：同 `startedAt` 的重投收敛到一行）。 */
  async record(run: MemoryRunRecord): Promise<MemoryRunRecord> {
    await this.runs.put(run.runId, run)
    return run
  }

  run(runId: string): MemoryRunRecord | undefined {
    return this.runs.get(runId)
  }

  /** 全部蒸馏行，按 `startedAt` 升序 —— 测试与看板读「这一周跑了几夜、各写了几个文件」用。 */
  all(): MemoryRunRecord[] {
    return [...this.runs.entries()]
      .map(([, record]) => record)
      .sort((a, b) => a.startedAt - b.startedAt)
  }

  latest(): MemoryRunRecord | undefined {
    const all = this.all()
    return all[all.length - 1]
  }
}
