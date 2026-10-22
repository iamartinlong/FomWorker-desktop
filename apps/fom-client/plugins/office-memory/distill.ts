/**
 * Deep Dream 一次蒸馏（设计 §3.5，实现顺序第 5 步）。覆盖 ME2 / ME3 / ME10。
 *
 * 这里是**确定性机制**那一半：水位线幂等、按分值淘汰、索引整段重建、对账落账。
 * 「从当天流水里提炼出什么新条目」是**模型**的活（§3.5 输入输出里那句"新增条目"），
 * 住在蒸馏会话的模型回合里，经 `memory_write` 落盘 —— 本模块把它做成可注入的 `promote` 钩子，
 * 于是同一份蒸馏代码既能真跑（夜里模型驱动），也能在没有模型时把三条守卫逐条断言。
 *
 * 三条不可让的形状：
 * - **幂等靠水位线 + 加法协议**（DM8 / ME3）：没有新日级 ⇒ 一条不写；水位线丢了也不重复，
 *   因为新增走 `store.writeEntry` 的 `wx`（同 slug 已存在即拒），索引重建是从磁盘现算的确定函数。
 * - **手改保护**（ME2）：蒸馏只读不改条目正文（它压根不写正文），且**绝不淘汰 `handEdited` 的条目**；
 *   预算与「不动人手改的内容」冲突时，让预算输。
 * - **单写者**（ME10）：`MEMORY.md` 只在这里被**整段覆盖**。成员进程不碰它。整段重写天然不留
 *   指向已归档文件的悬空行 —— 那是增量更新的失败形态。
 */

import { DEFAULT_BUDGET, type IndexBudget } from './inject.ts'
import { memoryScore } from './recall.ts'
import { INDEX_HEADER, MemoryRefusalError, type MemoryStore, type ReadEntry } from './store.ts'
import { runIdOf, type MemoryRunLedger, type MemoryRunRecord } from './run-ledger.ts'

const DAY_MS = 86_400_000

/** 距今多少天。无出生时间（人自己放进目录的文件必然如此，也必然 `handEdited`）按 0 处理 —— 不罚旧。 */
export function ageDaysOf(createdAt: string, now: number): number {
  if (createdAt === '') return 0
  const at = Date.parse(createdAt)
  if (Number.isNaN(at)) return 0
  return (now - at) / DAY_MS
}

/**
 * 一次蒸馏的淘汰计划（纯函数，不碰磁盘）。
 *
 * 分值 = `类型权重 × exp(-Δ天/τ) × 命中密度`，无查询 ⇒ 密度恒 1（`recall.ts`），所以这里实际是
 * 「权重高且近的留下」。裁到 `maxLines`：**超线且非手改**的先淘汰；**超线但手改**的留下并计入
 * `guardedSkips`（ME2 压过 ME1 —— 一条老到手改过的 reference 也不会被自动撤）。留下的顺序按分值降序，
 * 于是索引天然把最重要的排在最前，常驻段的读取顺序对模型友好。
 */
export interface DistillPlan {
  readonly kept: readonly ReadEntry[]
  readonly evictions: readonly ReadEntry[]
  readonly guardedSkips: number
}

export function planDistill(
  entries: readonly ReadEntry[],
  options: { budget?: IndexBudget; now: number; tauDays?: number } = { now: Date.now() },
): DistillPlan {
  const budget = options.budget ?? DEFAULT_BUDGET
  const scored = entries.map(entry => ({
    entry,
    score: memoryScore(
      { type: entry.type, ageDays: ageDaysOf(entry.createdAt, options.now), indexText: `${entry.title} ${entry.hook}` },
      { tauDays: options.tauDays },
    ),
  }))
  scored.sort((a, b) => b.score - a.score || a.entry.relativePath.localeCompare(b.entry.relativePath))

  const kept: ReadEntry[] = []
  const evictions: ReadEntry[] = []
  let guardedSkips = 0
  scored.forEach(({ entry }, index) => {
    if (index < budget.maxLines) {
      kept.push(entry)
      return
    }
    // 超预算：手改的条目不动（ME2），非手改的才进淘汰候选。
    if (entry.handEdited) {
      kept.push(entry)
      guardedSkips += 1
      return
    }
    evictions.push(entry)
  })
  return { kept, evictions, guardedSkips }
}

/** 从幸存条目整段渲染 `MEMORY.md`（`INDEX_HEADER` 之后一行一条，注入器只认条目行、标题行自然跳过）。 */
export function renderIndex(kept: readonly ReadEntry[]): string {
  if (kept.length === 0) return `${INDEX_HEADER}\n`
  return `${INDEX_HEADER}\n\n${kept.map(entry => entry.indexLine).join('\n')}\n`
}

/** 模型侧提炼的落点：拿到「水位线之后的日级」，自己决定新增哪些条目（经 `store.writeEntry`，加法）。 */
export interface PromoteInput {
  readonly store: MemoryStore
  readonly newDays: readonly string[]
}
export interface PromoteResult {
  /** 本轮新增成功的条目数（`writeEntry` 抛 EEXIST 而不新增，不计入这里）。 */
  readonly promoted: number
}

export interface DistillOptions {
  readonly now?: () => number
  readonly tauDays?: number
  readonly budget?: IndexBudget
  readonly promote?: (input: PromoteInput) => Promise<PromoteResult>
}

export interface DistillDeps {
  readonly store: MemoryStore
  readonly ledger: MemoryRunLedger
}

/**
 * 跑一次蒸馏，返回落进 `office_memory_run` 的那条对账行。
 *
 * 抛错时**不推水位线**：让同一批日级下次重蒸（幂等由加法协议兜住），而不是把没处理的东西
 * 记成已处理 —— 那正是 ME3 反过来要避免的「水位线跑在内容前面」。
 */
export async function distillOnce(deps: DistillDeps, options: DistillOptions = {}): Promise<MemoryRunRecord> {
  const clock = options.now ?? (() => Date.now())
  const startedAt = clock()
  const watermark = await deps.store.readWatermark()
  const watermarkFrom = watermark?.lastDay ?? null
  const days = await deps.store.listDailyDays()
  const newDays = watermark === undefined ? days : days.filter(day => day > watermark.lastDay)

  // DM8 幂等闸：没有新日级文件 ⇒ 一条不写，索引与条目一个字节都不动，收尾记一条 no-op（不是没跑，是跑而无事可做）。
  if (newDays.length === 0) {
    const current = await deps.store.scanEntries()
    return await deps.ledger.record({
      runId: runIdOf(startedAt),
      startedAt,
      finishedAt: clock(),
      outcome: 'no-op',
      promoted: 0,
      archived: 0,
      indexLines: current.length,
      guardedSkips: 0,
      watermarkFrom,
      watermarkTo: watermarkFrom ?? '',
    })
  }

  // ① 提炼新条目（模型侧；没有钩子就只做重排与淘汰）。`store.writeEntry` 保证加法 ⇒ 重蒸零新增（ME3）。
  let promoted = 0
  if (options.promote !== undefined) {
    promoted = (await options.promote({ store: deps.store, newDays })).promoted
  }

  // ② 计划并执行淘汰。归档失败（越权/同名撞车等 `MemoryRefusalError`）不吞：让它冒上去，
  //    这条守卫的失败必须是"这一夜没蒸成功"，而不是"悄悄少撤了一条还在索引里"。
  const plan = planDistill(await deps.store.scanEntries(), { budget: options.budget, now: clock(), tauDays: options.tauDays })
  let archived = 0
  for (const victim of plan.evictions) {
    await deps.store.archiveEntry(victim.relativePath, '夜间蒸馏按分值淘汰（低权重且陈旧）')
    archived += 1
  }

  // ③ 索引整段重建（ME10 单写者）—— 覆盖写，绝不增量。
  await deps.store.writeIndex(renderIndex(plan.kept))

  // ④ 全部落成才前移水位线（顺序是有意的：见上面「不推水位线」那段）。
  const lastDay = days[days.length - 1] as string
  await deps.store.writeWatermark(startedAt, lastDay)

  return await deps.ledger.record({
    runId: runIdOf(startedAt),
    startedAt,
    finishedAt: clock(),
    outcome: 'distilled',
    promoted,
    archived,
    indexLines: plan.kept.length,
    guardedSkips: plan.guardedSkips,
    watermarkFrom,
    watermarkTo: lastDay,
  })
}

/** 复用 store 的拒绝类型，让调用方在没有 `store` 依赖的测试里也能识别"归档被守卫挡下"。 */
export { MemoryRefusalError }
