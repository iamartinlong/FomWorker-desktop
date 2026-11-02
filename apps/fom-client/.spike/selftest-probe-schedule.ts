/**
 * `.spike/probe-schedule-shape.ts`（§8 第 8 条的收口探针）的**自证**：探针自己也要先被证明
 * 「认得出会说认得出、认不出会说清是过滤没命中还是形状变了、还没武装不会报成跑坏了」。
 *
 * 它证明的重点是**同源**：探针的归属结果必须与判据 `nightly-job-single` 用的是同一个谓词
 * （标题**或**正文与 `arm.ts` 常量逐字相等）。所以有一例专门只让正文命中、标题漂掉——探针若自己
 * 另写一份「只比标题」的遍历，这一例会变红，而那正是「形状对了但判据认不出」那一夜会漏掉的情形。
 *
 * 四种出口码各有反例：`0` 认得出且列集合相符 / `1` 有 daily 形却零归属、或列集合缺或多 /
 * `3` 文档里没有任何 daily 形（本机那 39 行全是审批层 `at` 形，就是这个样子）/ `2` 读不到、
 * 非法 JSON、或没有 `tables.tasks`。另加一条**正文不泄漏**的断言：那份文档跨实例共享，
 * 探针只许印结构与列名，把 `arm.ts` 的标题／正文当哨兵串去查输出行，出现即红。
 *
 * ⚠️ 全程不起产品进程、**不读** `C:/Users/EDY/.dsh/`（fixture 写在临时目录），所以它证明的是探针这台仪器，
 * 不是「内核真写出的那一行确实长这样」——那句仍要观测当天用真文档跑一次探针（task #43）。
 *
 * 跑法（spike `.ts` 用内核那份 tsx，所以在内核根跑）：
 *   cd ../deepseek-harness && node --import tsx/esm "../apps/fom-client/.spike/selftest-probe-schedule.ts"
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DISTILL_PROMPT, DISTILL_TITLE } from '../plugins/office-memory/arm.ts'
import { type JobSpec, writeRawScheduleDoc, writeSchedule } from './schedule-fixture.ts'
import { probeSchedule, type ProbeResult } from './probe-schedule-shape.ts'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-schedule-'))
let failures = 0

function file(name: string): string {
  return path.join(dir, name)
}

function expect(label: string, result: ProbeResult, want: { exitCode: number, contains?: string[], notContains?: string[] }): void {
  const problems: string[] = []
  if (result.exitCode !== want.exitCode) problems.push(`exit=${String(result.exitCode)}（要 ${String(want.exitCode)}）`)
  const text = result.lines.join('\n')
  // 每一次输出都得自报家门——那一夜的探针结论要能对上它读的是哪份 `schedule.json`（数据根可能不是本机默认）。
  if (!/^scheduleFile=/m.test(text)) problems.push('没有 `scheduleFile=` 那行（结论对不上读的是哪份文档）')
  ;(want.contains ?? []).forEach(needle => {
    if (!text.includes(needle)) problems.push(`输出里没有「${needle}」`)
  })
  ;(want.notContains ?? []).forEach(needle => {
    if (text.includes(needle)) problems.push(`输出泄漏了「${needle}」`)
  })
  if (result.lines.length === 0) problems.push('一行输出都没有（exit=0 + 零输出＝没跑，不是通过）')
  if (problems.length > 0) {
    failures += 1
    console.log(`✗ ${label} — ${problems.join('；')}\n  实际输出：${text.replace(/\n/g, ' ⏎ ')}`)
    return
  }
  console.log(`✓ ${label} — exit=${String(result.exitCode)}，${String(result.lines.length)} 行输出`)
}

function probe(name: string, jobs: readonly JobSpec[]): ProbeResult {
  writeSchedule(file(name), jobs)
  return probeSchedule(file(name))
}

// ① 正向：内核那一行（默认列集合 = `DailyScheduleRecord`）被认出，且列集合逐字相符。
expect('① 正向：真形状的那一行认得出 ⇒ exit 0', probe('one-daily.json', [{ jobId: 'job-nightly-1' }]),
  { exitCode: 0, contains: ['job-nightly-1', 'kind=daily', '已点火=0 次', '认得出'] })

// ② 同源：只有正文命中、标题漂掉 ⇒ 判据那边也是「标题**或**正文」，探针不能自己收窄成只比标题。
expect('② 正向：只有正文命中也算认得出（探针与判据同一个谓词）', probe('prompt-only.json', [{ jobId: 'job-nightly-1', title: '内核改了标题文案' }]),
  { exitCode: 0, contains: ['job-nightly-1'] })

// ③ 反向：有 daily 形却没有一行被认出 ⇒ 是「过滤没命中」，不能读成「还没武装」。
expect('③ 反向：daily 形在而归属没命中 ⇒ exit 1，且说清去核哪一层', probe('drifted.json', [{ jobId: 'job-nightly-1', title: '别的标题', prompt: '别的正文' }]),
  { exitCode: 1, contains: ['归属过滤没命中', 'arm.ts'] })

// ④ 反向：本机真实形状——只有审批层那些一次性任务 ⇒ 「还没武装」，出口码 3 而不是 1。
expect('④ 反向：整份文档只有 at 形 ⇒ exit 3（还没武装，不是跑坏了）',
  probe('at-only.json', [
    { jobId: 'job-urge-1', shape: 'at' },
    { jobId: 'job-urge-2', shape: 'at', title: '审批过期' },
    { jobId: 'job-urge-3', shape: 'at', prompt: '正文里带 ops_password 也不该被认出来' },
  ]),
  { exitCode: 3, contains: ['kind=daily', 'at=3'], notContains: ['ops_password'] })

// ⑤ 反向：内核那一行的 `time` 列整列没写 ⇒ 判据会静默读成空串，探针必须按列集合不符出声。
expect('⑤ 反向：record 少一列 ⇒ exit 1 且点名少的是哪列', probe('missing-col.json', [{ jobId: 'job-nightly-1', drop: ['time'] }]),
  { exitCode: 1, contains: ['少列：time'] })

// ⑥ 反向：多一列 ⇒ 这份文档不是这版内核写的（或 `DailyScheduleRecord` 变了），同样要拦。
expect('⑥ 反向：record 多一列 ⇒ exit 1 且点名多的是哪列', probe('extra-col.json', [{ jobId: 'job-nightly-1', extra: { kernelOnlyCol: 'x' } }]),
  { exitCode: 1, contains: ['多列：kernelOnlyCol'] })

// ⑦ 正向：`status` 是带 default 的列，整列不写不算异常（防误红——观测当天内核真写出的那行可能就没写）。
expect('⑦ 正向：status 整列不写 ⇒ 读成 active 且 exit 0', probe('no-status.json', [{ jobId: 'job-nightly-1', status: null }]),
  { exitCode: 0, contains: ['status=active'] })

// ⑧ 反向：文件不在场（数据根不是这里）⇒ 探针对「读不到」和「没有 daily 行」必须是两种出口码。
{
  const missing = file('never-written.json')
  expect('⑧ 反向：文件不在场 ⇒ exit 2 并指向传路径这个动作', probeSchedule(missing),
    { exitCode: 2, contains: ['读不到', missing] })
}

// ⑨ 反向：半截 JSON ⇒ exit 2，且红话说「不是合法 JSON」，不能与「没有 daily 行」混成一句。
{
  const broken = file('broken.json')
  writeRawScheduleDoc(broken, '{"unit":{"name":"schedule","vers')
  expect('⑨ 反向：非法 JSON ⇒ exit 2 且说清是读不成', probeSchedule(broken), { exitCode: 2, contains: ['不是合法 JSON'] })
}

// ⑩ 反向：信封换形（没有 `tables.tasks`）⇒ exit 2，这是「内核调度层换形」那一支的信号。
{
  const envelope = file('no-tasks.json')
  writeRawScheduleDoc(envelope, JSON.stringify({ unit: { name: 'schedule', version: 1 }, global: {}, tables: { other: {} } }))
  expect('⑩ 反向：没有 tables.tasks ⇒ exit 2 且指向换形', probeSchedule(envelope), { exitCode: 2, contains: ['tables.tasks'] })
}

// ⑪ 混合：别人的任务多不能把我这条挤没——结构计数如实，归属只那一行。
expect('⑪ 正向：daily 一行 + at 三行 ⇒ 只认出那一行，kind 分布写全',
  probe('mixed.json', [
    { jobId: 'job-urge-1', shape: 'at' },
    { jobId: 'job-nightly-1' },
    { jobId: 'job-urge-2', shape: 'at' },
    { jobId: 'job-urge-3', shape: 'at' },
  ]),
  { exitCode: 0, contains: ['共 4 行', 'at=3', 'daily=1', '1 行被认出'] })

// ⑫ 正文不泄漏：那份文档跨实例共享，探针只许印结构与列名——标题与正文出现在任何一行都是缺陷。
{
  const leaked = probe('leak-check.json', [{ jobId: 'job-nightly-1' }])
  expect('⑫ 正向的痕迹里不含标题／正文正文', leaked,
    { exitCode: 0, notContains: [DISTILL_TITLE, DISTILL_PROMPT] })
}

fs.rmSync(dir, { recursive: true, force: true })

if (failures > 0) {
  console.log(`\nFAIL：${String(failures)} 项探针行为不符`)
  process.exit(1)
}
console.log('\nPASS 调度层收口探针自证（12 ✓：4 种出口码各有反例 + 归属谓词与判据同源 + 列集合缺/多 + status 缺列不误红 + 混合归属 + 正文不泄漏；fixture 写在临时目录，未起产品进程、未读 .dsh）')
