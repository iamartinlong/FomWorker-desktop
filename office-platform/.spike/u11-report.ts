/**
 * 自用验收周的 **U11 量尺**：把审批台账变成几个可复读的数字。
 *
 * 为什么要有它：§9 U11 的定案是「按现状跑，验收周量『一天被问几次、其中几次是 `web_search` / `web_fetch`』
 * 的检索卡占比，再在聚合审批 / 租户白名单 / 更轻卡片里三选一」。那个决定要的是一把**尺**，不是一份日志：
 * `.spike/dump-ledger.cjs` 逐行打印给人肉眼读 —— 没有按天聚合、没有检索占比、还把 `.dsh` 路径写死在源码里
 * （而铁律是「别宽读 `C:/Users/EDY/.dsh/`」，用它就得改代码）。
 *
 * 两条不可谈的取向：
 * ① **读经真 storage-domain**，不自己拼磁盘形状。`<root>/office_approval_ledger/requests/*.json` 是信封
 *   `{version,record}`，手写解析这一轮已经抓出过一次假绿（见 `selftest-verify-step6.ts` 的剥壳），而
 *   `ledger.requestsOf` / `openRequests` 用的那扇 `table('requests').entries()` 就是产品自己读的同一扇门 ——
 *   统计与产品看到同一批记录才算数。
 * ② **绝不静默丢行**：磁盘上的 `.json` 文件数与读回来的记录数不符 ⇒ 报告点名差集并以 exit 1 结束。
 *   占比的分母要是少的，U11 就会被读成「检索卡没那么烦人」，那等于换个写法放宽。
 *
 * 正文零泄漏：输出只有工具名、等级、状态、时刻、`argsDigest` 前缀，**绝不**打印 `toolArgs` / `actionSummary` /
 * `displayReason` —— 台账里躺着参数原文（§4 最小暴露），统计件没有理由把它们带到终端或 `--out` 文件里。
 *
 * 重复询问这一把尺**用产品自己的口径**：`argsDigest(record.toolArgs)`，与 U9 卡片上的「第 N 次为同一个动作
 * 请求放宽」、与批件消费的摘要一字不差（`justification` 被 `argsDigest` 剔掉，所以只差理由的两次询问会算进同一组
 * —— 那正是 U9 定案要的语义）。跨会话不并组：U9 的谓词按 `sessionId` 过滤，卡片说的是「这个会话里第几次」。
 *
 * 跑法（`--import tsx/esm` 需要内核那份 tsx，所以在内核根执行；纯读盘，不起产品、不产生模型回合）：
 *   cd ../deepseek-harness && node --import tsx/esm \
 *     "../office-platform/.spike/u11-report.ts" --storage-root <storages 目录> \
 *     [--since 2026-10-11] [--until 2026-10-18] [--search-tools web_search,web_fetch] [--json] [--out 文件]
 * 退出码：`0` 数好了；`1` 有行没被读回来（磁盘形状/挂载不对）或窗口里一条记录都没有；`2` 用法错。
 */
import fs from 'node:fs'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { approvalLedgerDomain, argsDigest, type ApprovalRequestRecord } from '../plugins/office-approval/ledger.ts'

/** U11 问的是「出网检索要不要一张卡」，分子默认**只有**这两个名字，按全名精确匹配（不是 `includes`）。 */
export const defaultSearchTools: readonly string[] = ['web_search', 'web_fetch']

export interface SummaryOptions {
  readonly since?: number | undefined
  /** 开区间上界：`askedAt < until`。给整天边界时用 `2026-10-12` 而不是 `2026-10-11T23:59:59`。 */
  readonly until?: number | undefined
  readonly searchTools?: readonly string[]
}

export interface RepeatGroup {
  readonly sessionId: string
  readonly toolName: string
  readonly digest: string
  readonly count: number
}

export interface AskSummary {
  /** 落进时间窗、且形状可读的记录数 —— 所有占比的分母。 */
  readonly counted: number
  /** `askedAt` 在窗口之外的条数（不是丢弃，只是不属于本次窗口）。 */
  readonly outOfRange: number
  /** 读了但形状不可信的记录主键 —— 它们**不进**任何聚合。 */
  readonly anomalous: readonly string[]
  readonly byStatus: Readonly<Record<string, number>>
  readonly byRisk: Readonly<Record<string, number>>
  readonly byTool: readonly { toolName: string, count: number }[]
  readonly searchCount: number
  /** `counted === 0` 时给 `0` 而不是 `NaN` —— 空窗口要报「没数据」，不能报一个骗得过肉眼的小数。 */
  readonly searchShare: number
  readonly sessions: number
  readonly decidedInWindow: number
  readonly decidedAfterWindow: number
  readonly awaitingDecision: number
  readonly perDay: readonly { day: string, total: number, search: number }[]
  readonly repeatGroups: readonly RepeatGroup[]
  readonly maxRepeat: number
}

/** 形状判定只看「这几个字段能不能当数/名字用」，正文一律不看。 */
function isReadable(record: ApprovalRequestRecord): boolean {
  return typeof record.requestId === 'string'
    && typeof record.sessionId === 'string'
    && typeof record.toolName === 'string'
    && typeof record.status === 'string'
    && Number.isFinite(record.askedAt)
    && Number.isFinite(record.windowEndsAt)
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1
}

function dayOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

/** 按计数降序、同数按名字升序 —— 验收周每天跑一次，顺序稳定才好逐日比对。 */
function ranked(counts: Record<string, number>): { key: string, count: number }[] {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([key, count]) => ({ key, count }))
}

/** 磁盘上有这个文件、域里没读回来的主键 —— 「静默丢行」的证据（分母少了就是假绿）。 */
export function findDroppedRequests(
  files: readonly string[],
  records: readonly ApprovalRequestRecord[],
): string[] {
  const seen = new Set(records.map(record => record.requestId))
  return files
    .filter(name => name.endsWith('.json'))
    .map(name => name.slice(0, -'.json'.length))
    .filter(id => !seen.has(id))
    .sort()
}

interface Accumulator {
  readonly byStatus: Record<string, number>
  readonly byRisk: Record<string, number>
  readonly tools: Record<string, number>
  readonly dayTotal: Record<string, number>
  readonly daySearch: Record<string, number>
  readonly sessions: Set<string>
  readonly repeats: Map<string, RepeatGroup>
  readonly anomalous: string[]
  readonly counts: {
    counted: number
    outOfRange: number
    search: number
    inWindow: number
    afterWindow: number
    awaiting: number
  }
}

function newAccumulator(): Accumulator {
  return {
    byStatus: {},
    byRisk: {},
    tools: {},
    dayTotal: {},
    daySearch: {},
    sessions: new Set(),
    repeats: new Map(),
    anomalous: [],
    counts: { counted: 0, outOfRange: 0, search: 0, inWindow: 0, afterWindow: 0, awaiting: 0 },
  }
}

export function summarizeAsks(
  records: readonly ApprovalRequestRecord[],
  options: SummaryOptions = {},
): AskSummary {
  const searchNames = new Set(options.searchTools ?? defaultSearchTools)
  const since = options.since ?? Number.NEGATIVE_INFINITY
  const until = options.until ?? Number.POSITIVE_INFINITY
  const acc = newAccumulator()

  for (const record of records) {
    if (!isReadable(record)) {
      acc.anomalous.push(typeof record.requestId === 'string' ? record.requestId : '(无 requestId)')
      continue
    }
    if (!(record.askedAt >= since && record.askedAt < until)) {
      acc.counts.outOfRange += 1
      continue
    }
    const day = dayOf(record.askedAt)
    acc.counts.counted += 1
    acc.sessions.add(record.sessionId)
    bump(acc.byStatus, String(record.status))
    bump(acc.byRisk, String(record.riskLevel))
    bump(acc.tools, record.toolName)
    bump(acc.dayTotal, day)
    if (searchNames.has(record.toolName)) {
      acc.counts.search += 1
      bump(acc.daySearch, day)
    }
    // 「有没有人给结局」按 `decidedAt` 判而不是按状态判：`expired` 在 M1 里有两种含义（超窗转后台门还开 /
    // 批件到期门关上），产品侧的 `isDecidable` 早就为此改看 `expiresAt`，这里跟着同一个事实走。
    if (record.decidedAt === null || record.decidedAt === undefined) acc.counts.awaiting += 1
    else if (record.decidedAt <= record.windowEndsAt) acc.counts.inWindow += 1
    else acc.counts.afterWindow += 1

    // 与 `sessionRepeatAsks` 同一把尺：digest 由产品自己算（`justification` 天然被剔），
    // 于是「只差理由的第二次询问」落进同一组 —— 那正是卡片会说「第 2 次」的那一次。
    const digest = argsDigest(record.toolArgs as Record<string, unknown>)
    const key = `${record.sessionId}|${record.toolName}|${digest}`
    const seen = acc.repeats.get(key)
    if (seen === undefined) {
      acc.repeats.set(key, { sessionId: record.sessionId, toolName: record.toolName, digest, count: 1 })
    } else {
      acc.repeats.set(key, { ...seen, count: seen.count + 1 })
    }
  }

  const repeatGroups = [...acc.repeats.values()]
    .filter(group => group.count > 1)
    .sort((a, b) => b.count - a.count
      || (`${a.sessionId}${a.toolName}` < `${b.sessionId}${b.toolName}` ? -1 : 1))
  const days = Object.keys(acc.dayTotal).sort()

  return {
    counted: acc.counts.counted,
    outOfRange: acc.counts.outOfRange,
    anomalous: acc.anomalous,
    byStatus: acc.byStatus,
    byRisk: acc.byRisk,
    byTool: ranked(acc.tools).map(entry => ({ toolName: entry.key, count: entry.count })),
    searchCount: acc.counts.search,
    searchShare: acc.counts.counted === 0 ? 0 : acc.counts.search / acc.counts.counted,
    sessions: acc.sessions.size,
    decidedInWindow: acc.counts.inWindow,
    decidedAfterWindow: acc.counts.afterWindow,
    awaitingDecision: acc.counts.awaiting,
    perDay: days.map(day => ({ day, total: acc.dayTotal[day] ?? 0, search: acc.daySearch[day] ?? 0 })),
    repeatGroups,
    maxRepeat: repeatGroups.length === 0 ? 0 : repeatGroups[0]!.count,
  }
}

/**
 * 渲染给人读的报告。**只出现名字、等级、状态、时刻、digest 前 8 位** ——
 * 正文（`actionSummary` / `displayReason` / `toolArgs`）一个字段都不落地，包括写进 `--out` 的那份。
 */
export function renderSummary(summary: AskSummary, window: { since?: number, until?: number }): string {
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`
  const iso = (at: number | undefined): string =>
    at === undefined ? '不限' : new Date(at).toISOString().slice(0, 19).replace('T', ' ') + 'Z'
  const lines: string[] = [
    'U11 量尺 · 审批台账统计（正文零泄漏）',
    `窗口：askedAt ∈ [${iso(window.since)}, ${iso(window.until)})`,
    '',
    `计入 ${summary.counted} 条（窗口外 ${summary.outOfRange} 条，形状不可信 ${summary.anomalous.length} 条）`,
    `会话数 ${summary.sessions}`,
    `检索类 ${summary.searchCount} 条 ⇒ 占比 ${pct(summary.searchShare)}  ← U11 三选一的那个数`,
    '',
    '按天：',
  ]
  for (const row of summary.perDay) {
    const share = row.total === 0 ? '0.0%' : pct(row.search / row.total)
    lines.push(`  ${row.day}  总 ${String(row.total).padStart(3)}  检索 ${String(row.search).padStart(3)}  ${share}`)
  }
  lines.push('', '按等级：')
  for (const [level, count] of Object.entries(summary.byRisk).sort()) {
    lines.push(`  ${level} ${count}`)
  }
  lines.push('', '按状态：')
  for (const [status, count] of Object.entries(summary.byStatus).sort()) {
    lines.push(`  ${status} ${count}`)
  }
  lines.push('', '按工具：')
  for (const row of summary.byTool) lines.push(`  ${row.toolName} ${row.count}`)
  lines.push('', '裁决：',
    `  窗口内给出结局 ${summary.decidedInWindow}`,
    `  超窗才给出结局 ${summary.decidedAfterWindow}`,
    `  仍在等结局 ${summary.awaitingDecision}`)
  lines.push('', `重复询问（同会话同参数，最多 ${summary.maxRepeat} 次）：`)
  if (summary.repeatGroups.length === 0) lines.push('  （无）')
  for (const group of summary.repeatGroups) {
    lines.push(`  ${group.count} 次  ${group.sessionId} / ${group.toolName}  ${group.digest.slice(0, 8)}`)
  }
  if (summary.anomalous.length > 0) {
    lines.push('', `形状不可信的主键（未计入任何聚合）：${summary.anomalous.join(', ')}`)
  }
  return lines.join('\n')
}

/** `<storages 根>/office_approval_ledger/requests` —— 台账自己那扇门背后的目录，只用来数文件。 */
export function requestsDir(storageRoot: string): string {
  return path.join(storageRoot, approvalLedgerDomain.name, 'requests')
}

/** 磁盘上的主键清单（文件名）。目录不存在 ⇒ 空数组，由调用方区分「没这本账」与「账是空的」。 */
export function requestFileNames(storageRoot: string): string[] {
  const dir = requestsDir(storageRoot)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort()
}

/**
 * 经**真 storage-domain** 读回全部审批记录：与 `ledger.requestsOf` / `openRequests` 同一扇
 * `table('requests').entries()`。这里刻意不复制那份 schema —— 复制一份就会有两份真相，
 * 而这条统计件唯一的价值是「它数的是产品自己记得的那些行」。
 */
export async function readAllRequests(storageRoot: string): Promise<ApprovalRequestRecord[]> {
  const ctx = new Context()
  try {
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: storageRoot })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    const domain = await ctx.storageDomain.open(approvalLedgerDomain)
    return [...domain.table('requests').entries()].map(([, record]) => record as ApprovalRequestRecord)
  } finally {
    await ctx.fiber.dispose()
  }
}

/** `YYYY-MM-DD`（按 UTC 零点）或毫秒数。解析不了 ⇒ `undefined`，由调用方报用法错。 */
export function parseTime(value: string): number | undefined {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const at = Date.parse(`${value}T00:00:00.000Z`)
    return Number.isNaN(at) ? undefined : at
  }
  if (/^\d+$/.test(value)) return Number(value)
  return undefined
}

export interface CliOptions {
  readonly storageRoot: string
  readonly since?: number | undefined
  readonly until?: number | undefined
  readonly searchTools?: readonly string[] | undefined
  readonly json: boolean
  readonly out?: string | undefined
}

/** 纯函数：argv ⇒ 选项或用法错误消息。`--storage-root` 必填，绝不默认到 `~/.dsh`（铁律：不宽读那棵树）。 */
export function parseCli(argv: readonly string[]): { ok: true, options: CliOptions } | { ok: false, message: string } {
  let storageRoot = ''
  let since: number | undefined
  let until: number | undefined
  let searchTools: readonly string[] | undefined
  let json = false
  let out: string | undefined
  const valueFlags = new Set(['--storage-root', '--since', '--until', '--search-tools', '--out'])
  for (let i = 0; i < argv.length;) {
    const flag = argv[i]!
    // 开关先于取值判：`--json` 排在最后一个时，把它当「要吃值的键」会报一句假的「缺取值」，
    // 而真正的用法错（没给 `--storage-root`）就被埋在下一轮才说。
    if (flag === '--json') {
      json = true
      i += 1
      continue
    }
    if (!valueFlags.has(flag)) return { ok: false, message: `不认识开关 ${flag}` }
    const value = argv[i + 1]
    if (value === undefined) return { ok: false, message: `${flag} 缺取值` }
    i += 2
    if (flag === '--storage-root') storageRoot = value
    else if (flag === '--since') {
      const at = parseTime(value)
      if (at === undefined) return { ok: false, message: `--since 不接受：${value}` }
      since = at
    } else if (flag === '--until') {
      const at = parseTime(value)
      if (at === undefined) return { ok: false, message: `--until 不接受：${value}` }
      until = at
    } else if (flag === '--search-tools') {
      searchTools = value.split(',').map(name => name.trim()).filter(name => name !== '')
      if (searchTools.length === 0) return { ok: false, message: '--search-tools 给了空名单（空名单＝一条都不算检索，那不如不给）' }
    } else out = value
  }
  if (storageRoot === '') return { ok: false, message: '--storage-root 必填（storages 目录，不默认）' }
  return { ok: true, options: { storageRoot, since, until, searchTools, json, out } }
}

/**
 * 数一遍并产出一份报告 + 退出码。这里不 `process.exit` 也不打印，好让 selftest 与变异检验调用同一扇门，
 * 并且**每一种「不该被当成好消息的 0」都在报告正文里留一句可断言的话**：
 * - 台账目录根本不存在（产品没在这台机器上落过账）；
 * - 磁盘上有文件、域里没读回来（分母少了）；
 * - 窗口内 0 条（窗口外可能有）。
 *
 * 三者都报 exit 1。让 `exit 0` 只对应「确实数到了东西」，验收周才可能靠这一句退出码判断今天有没有数据。
 */
export async function reportRun(options: CliOptions): Promise<{ code: number, report: string }> {
  const dir = requestsDir(options.storageRoot)
  const dirMissing = !fs.existsSync(dir)
  const files = requestFileNames(options.storageRoot)
  const records = await readAllRequests(options.storageRoot)
  const summary = summarizeAsks(records, {
    since: options.since,
    until: options.until,
    searchTools: options.searchTools,
  })
  const dropped = findDroppedRequests(files, records)
  const warnings: string[] = []
  if (dirMissing) warnings.push(`台账目录不存在：${dir} —— 这产品还没在这台机器上落过审批账，不是「零张卡」。`)
  if (dropped.length > 0) warnings.push(`磁盘上有、域里没读回来的主键（分母因此不可信）：${dropped.join(', ')}`)
  if (summary.counted === 0) {
    warnings.push(`窗口内 0 条（窗口外 ${summary.outOfRange} 条、形状不可信 ${summary.anomalous.length} 条）—— 别把这个当「检索卡不烦人」。`)
  }
  const code = warnings.length === 0 ? 0 : 1
  const report = options.json
    ? JSON.stringify({ ...summary, droppedFiles: dropped, requestsDir: dir, warnings }, null, 2)
    : renderSummary(summary, { since: options.since, until: options.until })
      + (warnings.length === 0 ? '' : `\n\n${warnings.join('\n')}`)
  return { code, report }
}

/**
 * CLI 那一层副作用：产出报告并落地（stdout 或 `--out`），返回退出码。
 * 与 `reportRun` 分开是为了让自检能只读文本、不往终端刷一屏。
 */
export async function runCli(options: CliOptions): Promise<number> {
  const { code, report } = await reportRun(options)
  if (options.out === undefined) console.log(report)
  else fs.writeFileSync(options.out, report + '\n', 'utf8')
  return code
}

// 精确 basename 判定：`endsWith('u11-report.ts')` 会让任何同名后缀的文件（含本件的 selftest）误跑一次。
if (process.argv[1] !== undefined && path.basename(process.argv[1]) === 'u11-report.ts') {
  const parsed = parseCli(process.argv.slice(2))
  if (!parsed.ok) {
    console.error(`${parsed.message}\n用法：node --import tsx/esm .spike/u11-report.ts --storage-root <storages 目录>`
      + ` [--since 2026-10-11] [--until 2026-10-18] [--search-tools web_search,web_fetch] [--json] [--out 文件]`)
    process.exit(2)
  }
  process.exitCode = await runCli(parsed.options)
}




