/**
 * §8 第 8 条那条未证前提的**收口探针**：内核真武装出来的那一行 `daily`，判据认不认得出？
 *
 * 它取代早前那份只印键名的 `.mjs`（`tables.tasks` 自己遍历一遍、按 kind 分桶列 `rowKeys/recordKeys`）——
 * 那种「形状像不像」回答不了这条前提：形状对了不等于**归属过滤**命中，探针与判据各读一份就会各说一句话。
 * 现在探针的归属结果**就是** `readSchedule` 的归属结果（同一次遍历、同一个 `arm.ts` 常量比较），
 * 所以「探针说认得出」与「判据 `nightly-job-single` 说认得出」不可能不一致。
 *
 * 出口码分四种，因为观测当天要区分的是「还没武装」与「武装了但认不出」：
 * - `0` 认得出，且列集合与 `DailyScheduleRecord` 逐字相符。
 * - `1` 有 `kind=daily` 行却零归属（`arm.ts` 文案与内核写出的 title/prompt 漂了），或被认出的行列集合缺／多。
 * - `3` 文档里没有任何 `kind=daily` 行 ⇒ 蒸馏进程从没武装过（第 5 枪前正常；判据此刻应报 pending 而不是 fail）。
 * - `2` 文档读不到、不是合法 JSON、或没有 `tables.tasks`（信封换形）。
 *
 * ⚠️ 那份 `schedule.json` 是**跨实例共享**的（本机 39 行全是审批层的一次性催办正文），所以这里只印
 * 结构与列名：`jobId`、`kind`、`time`、`timeZone`、`status`、`scheduledAt`、已点火次数——**标题与正文一律不取**，
 * `readSchedule` 也只把那几列交给判定。数据根不是本机默认时把真实路径作为第一个参数传进来。
 *
 * 跑法（spike `.ts` 用内核那份 tsx，`--import` 按 cwd 解析，所以在内核根跑）：
 *   cd ../deepseek-harness && node --import tsx/esm \
 *     "../office-platform/.spike/probe-schedule-shape.ts" [schedule.json 路径，缺省本机数据根那一份]
 */
import path from 'node:path'
import { DAILY_RECORD_KEYS } from './schedule-fixture.ts'
import { readSchedule, type ScheduleSnapshot } from './verify-step6.ts'

const DEFAULT_SCHEDULE_FILE = 'C:/Users/EDY/.dsh/storages/schedule.json'

export interface ProbeResult {
  readonly exitCode: number
  readonly lines: readonly string[]
}

// 产物与打印分开（②i 那条）：自证要断言的是 `{exitCode, lines}`，打印只是这层壳。
export function probeSchedule(file: string): ProbeResult {
  const snapshot = readSchedule(file)
  const lines = [`scheduleFile=${file}`]
  if (!snapshot.exists) return { exitCode: 2, lines: [...lines, `${file} 读不到 —— 数据根不是这里就把真实路径传进来（只有这一处缺省）`] }
  if (snapshot.error !== '') return { exitCode: 2, lines: [...lines, snapshot.error] }
  lines.push(`tables.tasks 共 ${String(snapshot.totalTasks)} 行，kind 分布＝${kindText(snapshot)}`)
  if (snapshot.rows.length === 0) {
    const daily = snapshot.kindCounts.daily ?? 0
    return daily === 0
      ? { exitCode: 3, lines: [...lines, '没有一行 `kind=daily` ⇒ 蒸馏进程从没武装过这条任务（第 5 枪前就该是这样）。判据 `nightly-job-single` 对同一份文档报 pending 才算口径一致。'] }
      : { exitCode: 1, lines: [...lines, `有 ${String(daily)} 行 \`kind=daily\` 却没有一行被认出 ⇒ 不是形状变了、是**归属过滤没命中**：去核 \`arm.ts\` 的 DISTILL_TITLE／DISTILL_PROMPT 与内核那两列写的是什么（探针按设计不打印它们，用 \`--out\` 那份判定快照或人眼看那条任务）`] }
  }
  snapshot.rows.forEach(row => {
    lines.push(`  认得出：jobId=${row.jobId} kind=${row.kind} time=${row.time || '(空)'} timeZone=${row.timeZone || '(空)'} status=${row.status} scheduledAt=${row.scheduledAt || '(空)'} 已点火=${String(row.deliveries)} 次`)
  })
  const shapeProblems = snapshot.rows.flatMap(row => {
    const missing = DAILY_RECORD_KEYS.filter(key => !row.recordKeys.includes(key))
    const extra = row.recordKeys.filter(key => !DAILY_RECORD_KEYS.includes(key))
    return [
      ...(missing.length === 0 ? [] : [`${row.jobId} 少列：${missing.join(',')}`]),
      ...(extra.length === 0 ? [] : [`${row.jobId} 多列：${extra.join(',')}（这份文档不是这版内核写的，或 \`DailyScheduleRecord\` 变了）`]),
    ]
  })
  if (shapeProblems.length > 0) {
    return { exitCode: 1, lines: [...lines, `认得出，但 record 列集合与内核 \`DailyScheduleRecord\`（期望 ${DAILY_RECORD_KEYS.join('/')}）不符 ⇒ 判据读那几列会静默读成空串：${shapeProblems.join('；')}`] }
  }
  return { exitCode: 0, lines: [...lines, `✓ 内核真写出的这行被判据认出，且列集合与 \`DailyScheduleRecord\` 逐字相符（${String(snapshot.rows.length)} 行被认出；kind/time/timeZone/status 合不合第 6 步的规格由判据 \`nightly-job-single\` 说，不在这里重复）`] }
}

function kindText(snapshot: ScheduleSnapshot): string {
  const entries = Object.entries(snapshot.kindCounts).sort()
  return entries.length === 0 ? '(空表)' : entries.map(([kind, count]) => `${kind}=${String(count)}`).join(', ')
}

const isCli = process.argv[1] !== undefined && path.basename(process.argv[1]) === 'probe-schedule-shape.ts'
if (isCli) {
  const { exitCode, lines } = probeSchedule(process.argv[2] ?? DEFAULT_SCHEDULE_FILE)
  lines.forEach(line => { console.log(line) })
  console.log(`结论 exit=${String(exitCode)}（0=认得出且形状相符 / 1=零归属或列集合不符 / 3=文档里没有 daily 形＝还没武装 / 2=读不到或信封不是 tables.tasks）`)
  process.exit(exitCode)
}
