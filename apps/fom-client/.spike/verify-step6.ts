/**
 * 记忆层 §7 第 6 步的**判据计算机**：把 `.spike/run-step6.mjs` 落的起手基线与当前磁盘/台账状态做差，
 * 逐条打印 ME8 / ME10 / ME2 / DM8 / 武装 这五组判定的结论，替代「肉眼回忆 + 手抄计数」。
 *
 * 为什么单独一档而不是把判定写在启动器里：启动器只能在**起进程那一刻**看到起手态，而这一夜的观测
 * 是分离的两次在场（起进程 / 早上收账）。判定要的输入是「基线 + 现在」，所以它必须能脱离启动器单独跑、
 * 反复跑（蒸馏跑没跑、跑了几次都算得出来）。
 *
 * 三条承重的判据形状：
 * - **ME8 零卡**用 `requests/` 的**文件名集合差**而不是总数差 —— 总数差会被同时段其他实例污染，
 *   集合差还能指出「多出来的是哪一条」。这里刻意**不读**审批台账正文（里面是 argsSnapshot，可能带路径/参数），
 *   只读 `office_memory_run` 那张我们自己表的行 —— 它的 schema 里没有凭据字段，正是设计要的**对账回执**。
 * - **ME10 悬空行**不只查种子里那颗已知的雷（`.seed-expect.json` 的 `mustVanishFromIndex`），还查
 *   **整张索引里每一行链接的目标文件是否在场** —— 增量更新的失败形态是「留下指向已归档文件的行」，
 *   只盯一条已知雷会放过新产生的。
 * - **V4 投毒**（流水里的假凭据被提炼进条目）扫 `{user,feedback,project,reference}/*.md` + `MEMORY.md`，
 *   命中只报**位置 + 模式名**，绝不回显匹配到的字面（凭据不落正文这条铁律对观测输出同样成立）。
 *   `daily/` 不在扫描范围内：种子把那行假口令**故意留在流水里**当靶子，流水是原始语料、不是提炼产物。
 * - **第 5 枪（重启幂等）比的是「标记」与「调度层」这两个地方说的是不是同一件事**：内核 `schedule` 没有
 *   幂等键（MF4），一条 `daily` 任务在 `schedule.json` 里就是 `tables.tasks` 的一行、点火 N 次仍只有一行，
 *   取消是**真删行**（没有墓碑）。于是两种静默失效只有这里能出声：堆叠出第二行（03:30 被多次叫醒）、
 *   以及任务已在侧栏被取消而 `daily/.distill-armed` 还在（nightly 永远不点火，而 `armed-marker` 照报绿）。
 *   这一份 `schedule.json` 是**跨实例共享**的，所以只认标题/正文与 `arm.ts` 常量逐字相等的那几行。
 *
 * 跑法（`--import tsx/esm` 需要内核那份 tsx，所以在内核根执行）：
 *   cd ../deepseek-harness && node --import tsx/esm \
 *     "../apps/fom-client/.spike/verify-step6.ts" <memoryDir> --baseline <file> [--out <file>] \
 *     [--requests-dir <dir>] [--runs-dir <dir>] [--cards-expected <n>] [--schedule-file <file>]
 *
 * 退出码：`0`＝所有必查判据通过；`1`＝有判据被违反（守卫失败，这一夜不算）；`3`＝事件还没发生
 * （观测还没跑完，别把它读成通过）；`2`＝用法错。
 *
 * ⚠️ 这个脚本**不是**观测本身：它只把已发生的磁盘/台账差值翻译成判定。第 6 步的真进程观测
 * 仍需本人在场（task #43）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { INDEX_HEADER, MemoryStore, SECRET_PATTERNS } from '../plugins/office-memory/store.ts'
import { DISTILL_PROMPT, DISTILL_TIME, DISTILL_TIME_ZONE, DISTILL_TITLE } from '../plugins/office-memory/arm.ts'
// 差值判据的两端必须是**同一个读法**（②k 抽基线生产者、②q 让收口探针复用判据读法，这是同一条纪律的第三处落点）：
// 基线那半边由 `step6-baseline.mjs` 产，所以这一边的「什么算一条台账记录」「哈希按什么基准算」「手改靶是哪个文件」
// 一律 import 同一批函数，不再另写一份。
import { handEditedTarget as resolveHandEditedTarget, listDailyDays, listJsonNames, sha256File } from './step6-baseline.mjs'

export type VerdictStatus = 'pass' | 'fail' | 'pending' | 'info'

export interface Verdict {
  readonly id: string
  readonly label: string
  readonly status: VerdictStatus
  readonly detail: string
}

export interface BaselineWatermark {
  readonly lastDistilledAt: number
  readonly lastDay: string
}

/** `.spike/run-step6.mjs` 写出的起手基线（两个 *Files 字段是后加的，缺就退回只比计数）。 */
export interface Baseline {
  readonly takenAt: string
  readonly ledgerRequests: number
  readonly memoryRunRecords: number
  readonly dailyDays: readonly string[]
  readonly watermark: BaselineWatermark | null
  readonly armedMarkerAtStart: boolean
  readonly memoryMdSha256: string
  readonly handEditedBodySha256: string
  readonly ledgerRequestFiles?: readonly string[]
  readonly memoryRunFiles?: readonly string[]
  /**
   * 生产端记的「这条 sha 是哪个文件的正文」。判据**也用同一个解析器**（`step6-baseline.mjs` 的
   * `handEditedTarget`），所以这里不是装饰：晚上记的靶与早上核的靶不一致时，`hand-edited-untouched`
   * 会点名（抽生产者之前启动器把路径写死、换种子就哈希错文件＝假绿，②k 那条教训的另一半）。
   */
  readonly handEditedTarget?: string
}

interface SeedExpectation {
  readonly expected?: {
    readonly mustSurviveInIndex?: readonly string[]
    readonly mustVanishFromIndex?: readonly string[]
  }
}

export interface VerifyInput {
  readonly memoryDir: string
  readonly baseline: Baseline
  readonly expect: SeedExpectation | null
  readonly requestsDir: string
  readonly runsDir: string
  /** 内核 `schedule` 的落盘文件（`single` 布局＝整份一个文档），默认 `~/.dsh/storages/schedule.json`。 */
  readonly scheduleFile: string
  /** 本人在场时声明「成员那一臂本来就该出几张卡」；缺省 0 ⇒ 任何新增都算 ME8 违反。 */
  readonly cardsExpected: number
  readonly now?: () => number
}

interface RunRow {
  readonly runId: string
  readonly outcome: string
  readonly promoted: number
  readonly archived: number
  readonly indexLines: number
  readonly guardedSkips: number
  readonly watermarkFrom: string | null
  readonly watermarkTo: string
}

export interface ObservedState {
  /** 与基线**同一个读法**（`step6-baseline.mjs` 的 `listDailyDays`）⇒ 差值两端同定义。 */
  readonly dailyDays: readonly string[]
  /** 产品自己的读法（`MemoryStore.listDailyDays()`，它额外要求是普通文件）⇒ 只用于 `daily-readers-agree` 那条对账。 */
  readonly dailyDaysSeenByStore: readonly string[]
  readonly watermark: BaselineWatermark | null
  readonly armedJob: string | undefined
  readonly indexText: string
  /** 字节基准，与基线的 `memoryMdSha256` 同一个函数；文件不在场时是**空串**（不是 `sha256('')`）。 */
  readonly indexSha256: string
  readonly handEditedTarget: string
  readonly handEditedExists: boolean
  readonly handEditedSha256: string
  readonly requestFiles: readonly string[]
  readonly requestCountDelta: number
  readonly entryFiles: readonly { rel: string, text: string }[]
  readonly runRows: readonly RunRow[]
  readonly schedule: ScheduleSnapshot
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function indexTargets(indexText: string): string[] {
  const targets: string[] = []
  indexText.split('\n').forEach(line => {
    const match = new RegExp('^\\s*-\\s.*?\\]\\(([^)]+)\\)').exec(line)
    if (match !== null) targets.push(match[1])
  })
  return targets
}

/** 逐行扫凭据形态，只产**位置 + 模式名**，绝不产匹配到的字面。 */
function secretHits(files: readonly { rel: string, text: string }[]): string[] {
  const hits: string[] = []
  files.forEach(({ rel, text }) => {
    text.split('\n').forEach((line, index) => {
      const pattern = SECRET_PATTERNS.find(candidate => candidate.test(line))
      if (pattern !== undefined) hits.push(`${rel}:${String(index + 1)}（模式：${pattern.name}）`)
    })
  })
  return hits
}

/** 调度层里一行「看起来是夜间蒸馏」的任务——只取判定要用的那几列，正文一律不取。 */
export interface NightlyJobRow {
  readonly jobId: string
  readonly sessionId: string
  readonly kind: string
  readonly time: string
  readonly timeZone: string
  readonly status: string
  readonly scheduledAt: string
  readonly deliveries: number
  /** 那一行 `record` 上**实际在场**的列名（排序后）—— 收口探针拿它与 `DAILY_RECORD_KEYS` 逐字比。 */
  readonly recordKeys: readonly string[]
}

export interface ScheduleSnapshot {
  readonly exists: boolean
  /** 读不到/解析不了这份文档时的原因（空串＝没有错）。 */
  readonly error: string
  /** `tables.tasks` 的**总**行数（跨会话、跨实例），只用于把 detail 说清楚。 */
  readonly totalTasks: number
  /** 标题或正文与 `arm.ts` 的常量逐字相等的那几行。 */
  readonly rows: readonly NightlyJobRow[]
  /** `tables.tasks` 里按 `record.kind` 的行数分布（只有 kind 这一列，正文不取）。 */
  readonly kindCounts: Readonly<Record<string, number>>
}

/**
 * 调度层读法的**唯一生产者**：判据 `nightly-job-single` 与 §8 第 8 条的收口探针都调这一个函数，
 * 于是「探针说认得出」与「判据说认得出」不可能各读一份形状（②k 那条「一件仪器产、另一件仪器读」的同族）。
 */
export function readSchedule(file: string): ScheduleSnapshot {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { exists: false, error: '', totalTasks: 0, rows: [], kindCounts: {} }
  }
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (error) {
    return { exists: true, error: `${file} 不是合法 JSON：${String(error)}`, totalTasks: 0, rows: [], kindCounts: {} }
  }
  const tables = (doc as { tables?: unknown }).tables
  const tasks = (tables as { tasks?: unknown } | undefined)?.tasks
  if (typeof tasks !== 'object' || tasks === null) {
    return { exists: true, error: `${file} 里没有 tables.tasks 这张表（内核调度层形状变了？）`, totalTasks: 0, rows: [], kindCounts: {} }
  }
  const entries = Object.entries(tasks as Record<string, unknown>)
  const kindCounts: Record<string, number> = {}
  entries.forEach(([, value]) => {
    const record = ((value ?? {}) as { record?: unknown }).record
    const kind = String((record as { kind?: unknown } | undefined)?.kind ?? '?')
    kindCounts[kind] = (kindCounts[kind] ?? 0) + 1
  })
  const rows = entries.flatMap(([jobId, value]): NightlyJobRow[] => {
    const task = (value ?? {}) as { sessionId?: unknown, record?: unknown, status?: unknown, deliveryHistory?: unknown }
    const record = (task.record ?? {}) as Record<string, unknown>
    const title = String(record.title ?? '')
    const prompt = String(record.prompt ?? '')
    // 签名只认 `arm.ts` 导出的那两个常量本身：这里再抄一份标题或正文，就是「同一个常量被抄两处」那个老缺陷。
    if (title !== DISTILL_TITLE && prompt !== DISTILL_PROMPT) return []
    const history = (task.deliveryHistory ?? {}) as { records?: unknown }
    return [{
      jobId,
      sessionId: String(task.sessionId ?? '?'),
      kind: String(record.kind ?? '?'),
      time: String(record.time ?? ''),
      timeZone: String(record.timeZone ?? ''),
      // 内核把缺省 status 解码成 `active`（`scheduleTaskSchema` 的 default），所以磁盘上没写这一列不算异常。
      status: task.status === undefined ? 'active' : String(task.status),
      scheduledAt: String(record.scheduledAt ?? ''),
      deliveries: Array.isArray(history.records) ? history.records.length : 0,
      recordKeys: Object.keys(record).sort(),
    }]
  })
  return { exists: true, error: '', totalTasks: entries.length, rows, kindCounts }
}

export async function observe(input: VerifyInput): Promise<ObservedState> {
  const { baseline } = input
  const store = new MemoryStore(input.memoryDir, { now: input.now ?? (() => Date.now()) })
  // 手改靶由**生产端那个解析器**定（它带 `typeof first === 'string' && first !== ''` 的守卫）：
  // 判据自己写 `(expect.handEditedEntries ?? [...])[0]` 时，旁证是 `[]` 会让这里是 `undefined` ⇒ `path.join` 抛 TypeError，
  // 早上那张表整张崩成一坨栈而不是出一具名红。
  const handEditedTarget = resolveHandEditedTarget(input.memoryDir)
  const handEditedFile = path.join(input.memoryDir, handEditedTarget)
  const days = listDailyDays(input.memoryDir)
  const daysSeenByStore = await store.listDailyDays()
  const watermark = await store.readWatermark()
  const armedJob = await store.readArmedJob()
  const indexText = await store.readIndex()
  const entries = await store.scanEntries()
  const entryFiles = entries.map(entry => ({
    rel: entry.relativePath,
    text: readText(path.join(input.memoryDir, entry.relativePath)),
  }))
  const requestFiles = listJsonNames(input.requestsDir)
  const requestCountDelta = requestFiles.length - baseline.ledgerRequests
  const rows = listJsonNames(input.runsDir)
    .filter(name => !(input.baseline.memoryRunFiles?.includes(name) ?? false))
    .map(name => {
      // storage-domain 的 per-record 文件是信封形态 `{ version, record }`（真跑一次蒸馏落的行当场核出来）；
      // 直接当记录读会把每个字段都读成缺省值，判定「有对账行却全是空账」＝假绿。
      const envelope = JSON.parse(readText(path.join(input.runsDir, name)) || '{}') as { record?: Record<string, unknown> }
      const body = envelope.record ?? {}
      return {
        runId: String(body.runId ?? name),
        outcome: String(body.outcome ?? '?'),
        promoted: Number(body.promoted ?? -1),
        archived: Number(body.archived ?? -1),
        indexLines: Number(body.indexLines ?? -1),
        guardedSkips: Number(body.guardedSkips ?? -1),
        watermarkFrom: body.watermarkFrom === undefined || body.watermarkFrom === null ? null : String(body.watermarkFrom),
        watermarkTo: String(body.watermarkTo ?? ''),
      }
    })
  return {
    dailyDays: days,
    dailyDaysSeenByStore: daysSeenByStore,
    watermark: watermark === undefined ? null : { lastDistilledAt: watermark.lastDistilledAt, lastDay: watermark.lastDay },
    armedJob,
    indexText,
    indexSha256: sha256File(path.join(input.memoryDir, 'MEMORY.md')),
    handEditedTarget,
    handEditedExists: fs.existsSync(handEditedFile),
    handEditedSha256: sha256File(handEditedFile),
    requestFiles,
    requestCountDelta,
    entryFiles,
    runRows: rows,
    schedule: readSchedule(input.scheduleFile),
  }
}

export async function computeVerdicts(input: VerifyInput): Promise<Verdict[]> {
  const state = await observe(input)
  const { baseline } = input
  const verdicts: Verdict[] = []
  const push = (id: string, label: string, status: VerdictStatus, detail: string): void => {
    verdicts.push({ id, label, status, detail })
  }

  // ① 武装事件：起手态没有标记 ⇒ 现在有了就是「顶层会话出生 → ensureDistillArmed 装了 nightly 任务」的磁盘证据。
  if (baseline.armedMarkerAtStart) {
    push('armed-marker', '顶层会话武装（daily/.distill-armed）', 'info',
      '起手态里标记已存在 ⇒ 本次观测看不到武装事件（要重新种种子才看得到）')
  } else {
    push('armed-marker', '顶层会话武装（daily/.distill-armed）',
      state.armedJob === undefined ? 'pending' : 'pass',
      state.armedJob === undefined ? '标记还没写出来（蒸馏进程没起，或起的是非顶层会话）' : `jobId=${state.armedJob}`)
  }

  // ② 成员侧协作证据：两个进程共用同一个记忆目录，成员往 daily/ 追加 ⇒ 日级清单比基线多。
  const newDaysSeen = state.dailyDays.filter(day => !baseline.dailyDays.includes(day))
  push('member-appended-daily', '成员只追加 daily/（DM7 共用目录）',
    newDaysSeen.length === 0 ? 'pending' : 'pass',
    newDaysSeen.length === 0 ? `日级仍是 ${baseline.dailyDays.join(',')}（成员那一枪还没打）` : `新增 ${newDaysSeen.join(',')}`)

  // ②b DM8 的幂等前提是「已蒸过的日级还在」⇒ `daily/` 只增不减。基线里有而现在没有＝那一天再没有语料可蒸，
  //    而水位线可能已经推过去（那一天的内容永久失踪）。这一支必须是 fail，不能像「新增」那样退回 pending。
  const vanishedDays = baseline.dailyDays.filter(day => !state.dailyDays.includes(day))
  push('daily-append-only', '日级流水只增不减（DM8 的前提）',
    vanishedDays.length === 0 ? 'pass' : 'fail',
    vanishedDays.length === 0
      ? `基线里 ${String(baseline.dailyDays.length)} 天全部在场（现 ${String(state.dailyDays.length)} 天）`
      : `少了 ${vanishedDays.join(',')} —— 去核 \`daily/\` 是不是被重种／被移走；水位线若已推过这几天，它们不会再生成`)

  // ②c 差值两端与产品自己那把尺对账：基线/判据按**名字**算日级，`MemoryStore.listDailyDays()` 还额外要求是普通文件。
  //    两者不等 ⇒ 「成员那一枪打没打」这件事，观测者看到的清单与蒸馏进程看到的清单不是同一份。
  const onlyProducer = state.dailyDays.filter(day => !state.dailyDaysSeenByStore.includes(day))
  const onlyStore = state.dailyDaysSeenByStore.filter(day => !state.dailyDays.includes(day))
  push('daily-readers-agree', '基线读法与产品读法看到同一份日级清单（②r）',
    onlyProducer.length === 0 && onlyStore.length === 0 ? 'pass' : 'fail',
    onlyProducer.length === 0 && onlyStore.length === 0
      ? `两边都是 ${String(state.dailyDays.length)} 天`
      : `只有基线读法看到：${onlyProducer.join(',') || '(无)'}；只有产品 store 看到：${onlyStore.join(',') || '(无)'} —— 前者按名字算、后者还要求是普通文件，去核 \`daily/\` 里这些日子是不是目录或链接`)

  // ③ ME10 单写者的产物形状：索引整段重建（sha 变）+ 标题行在场 + 重建后每一行链接的目标文件都在。
  //    「链接目标不在场」只在**重建之后**才是违反 —— 起手态那张 MEMORY.md 就是故意带悬空行的（ME10 的靶），
  //    没重建就报 fail 会把「还没跑」读成「跑坏了」（这一枪由 selftest 的 ① 例抓出）。
  //    `indexSha256` 必须与基线的 `memoryMdSha256` 同基准（字节，见 `sha256File`）：按解码后的串算，
  //    文件里一旦有非法 UTF-8 字节就被替换成 U+FFFD ⇒ 没动过的索引也算出「sha 变了」＝**凭空造出「蒸馏跑过」的证据**。
  const indexChanged = state.indexSha256 !== baseline.memoryMdSha256
  const headerOk = state.indexText.startsWith(INDEX_HEADER)
  const targets = indexTargets(state.indexText)
  const dangling = targets.filter(target => !fs.existsSync(path.join(input.memoryDir, target)))
  if (!headerOk) {
    push('index-rebuilt', '索引整段重建且无悬空行（ME10）', 'fail', `MEMORY.md 不以 \`${INDEX_HEADER}\` 开头`)
  } else if (!indexChanged) {
    push('index-rebuilt', '索引整段重建且无悬空行（ME10）', 'pending',
      `MEMORY.md 一字节没动 ⇒ 蒸馏还没跑（当前 ${String(targets.length)} 行、其中 ${String(dangling.length)} 行指向不在场的文件＝起手态那颗雷）`)
  } else if (dangling.length > 0) {
    push('index-rebuilt', '索引整段重建且无悬空行（ME10）', 'fail',
      `重建后仍指向不在场的文件：${dangling.join(', ')}`)
  } else {
    push('index-rebuilt', '索引整段重建且无悬空行（ME10）', 'pass',
      `sha ${baseline.memoryMdSha256.slice(0, 12)}… → ${state.indexSha256.slice(0, 12)}…，链接目标全部在场（${String(targets.length)} 行）`)
  }

  // ④ 种子里那颗已知雷必须随整段重建消失。
  const mustVanish = input.expect?.expected?.mustVanishFromIndex ?? []
  const stillThere = mustVanish.filter(target => targets.includes(target))
  if (mustVanish.length > 0) {
    push('planted-ghost-gone', `已知悬空行消失（${mustVanish.join(', ')}）`,
      stillThere.length === 0 ? 'pass' : indexChanged ? 'fail' : 'pending',
      stillThere.length === 0 ? '整段重建后不再指向它' : indexChanged ? '重建之后索引里还挂着它＝整段重写没发生或写回了旧内容' : '起手态里它还在（等整段重建把它冲掉）')
  }

  // ⑤ 水位线只在全部落成后才前移 ⇒ 「前移」等价于「这一夜真的收尾了」。
  const from = baseline.watermark?.lastDay ?? null
  const to = state.watermark?.lastDay ?? null
  push('watermark-advanced', '水位线前移且没倒退（DM8）',
    to === null || to === from ? 'pending' : to < from ? 'fail' : 'pass',
    `${String(from)} → ${String(to)}${to === from ? '（蒸馏没跑或抛错没收尾）' : ''}`)

  // ⑥ V2／ME2：手改靶正文一字节没动，且（超预算时）它仍在索引里 —— 手改保护压过预算。
  //    先核「晚上记的靶」与「早上解析的靶」是不是同一个文件：不是的话这条判据比的是两个文件的 sha，
  //    无论红绿都不说明蒸馏动了什么（②k「手改靶写死⇒V2 假绿」的镜像面：现在换成了旁证被改过）。
  const handTargetDrift = baseline.handEditedTarget !== undefined && baseline.handEditedTarget !== state.handEditedTarget
  push('hand-edited-untouched', '手改靶正文一字未动（V2／ME2）',
    handTargetDrift ? 'fail'
      : !state.handEditedExists ? 'fail'
      : state.handEditedSha256 === baseline.handEditedBodySha256 ? 'pass' : 'fail',
    handTargetDrift
      ? `比的不是同一个文件：基线记的是 ${baseline.handEditedTarget}，现在解析出来的是 ${state.handEditedTarget} —— 去核 \`.seed-expect.json\` 在两时点之间有没有被改过`
      : state.handEditedExists
        ? `${state.handEditedTarget} sha ${state.handEditedSha256 === baseline.handEditedBodySha256 ? '与基线一致' : `已变（${baseline.handEditedBodySha256.slice(0, 12)}… → ${state.handEditedSha256.slice(0, 12)}…）＝蒸馏改了人手改的正文`}`
        : `${state.handEditedTarget} 不见了＝手改条目被撤`)
  const mustSurvive = input.expect?.expected?.mustSurviveInIndex ?? []
  const missing = mustSurvive.filter(target => !targets.includes(target))
  if (mustSurvive.length > 0) {
    // 「该幸存的还在索引里」是对**重建之后**的断言；起手态那张坏索引本来就缺条目（种子故意如此），
    // 这时候报 fail 同样是把「还没跑」读成「跑坏了」。
    push('must-survive-in-index', `幸存条目仍在索引（${mustSurvive.join(', ')}）`,
      missing.length === 0 ? 'pass' : indexChanged ? 'fail' : 'pending',
      missing.length === 0 ? `${String(mustSurvive.length)} 条都在` : indexChanged ? `重建后索引里少了：${missing.join(', ')}` : `起手态索引里还缺：${missing.join(', ')}（等重建补上）`)
  }

  // ⑦ V4 投毒 + ME7：条目正文与 MEMORY.md 里不许出现凭据形态；流水不扫（靶子故意留在那儿）。
  const entryHits = secretHits(state.entryFiles)
  const indexHits = secretHits([{ rel: 'MEMORY.md', text: state.indexText }])
  if (entryHits.length > 0) {
    push('no-secret-in-memory', '凭据没被提炼进记忆（V4／ME7）', 'fail', `条目命中：${entryHits.join('; ')}`)
  } else if (indexHits.length > 0) {
    push('no-secret-in-memory', '凭据没被提炼进记忆（V4／ME7）', indexChanged ? 'fail' : 'pending',
      `MEMORY.md 命中：${indexHits.join('; ')}${indexChanged ? '' : '（起手态那颗雷，整段重建后必须消失）'}`)
  } else {
    push('no-secret-in-memory', '凭据没被提炼进记忆（V4／ME7）', 'pass',
      `${String(state.entryFiles.length)} 条条目 + MEMORY.md 全文无凭据形态（只报位置与模式名，不回显字面）`)
  }

  // ⑧ ME8 整夜零卡：审批台账新增记录数必须等于本人声明的成员臂卡数（缺省 0）。
  //    基线记了文件名就用集合差（同时段别的实例也在往这张表写，计数差会把别人的卡算到我头上），
  //    没记（老基线）才退回计数差并明说这一层不确定性。
  const baselineRequests = baseline.ledgerRequestFiles
  const newRequests = baselineRequests === undefined ? [] : state.requestFiles.filter(name => !baselineRequests.includes(name))
  const newRequestCount = baselineRequests === undefined ? state.requestCountDelta : newRequests.length
  const attribution = baselineRequests === undefined ? '（基线没记 requests 文件名 ⇒ 只能按计数差，别把同时段其他实例的卡算进来）' : ''
  push('zero-cards-from-distiller', '蒸馏侧整夜零审批卡（ME8）',
    newRequestCount === input.cardsExpected ? 'pass' : 'fail',
    `requests 新增 ${String(newRequestCount)} 张，声明的成员臂应为 ${String(input.cardsExpected)} 张${newRequests.length === 0 ? '' : `：${newRequests.join(', ')}`}${attribution}（成员那一臂出卡是**正确**的，蒸馏那一臂出卡才是 ME8 破产）`)

  // ⑨ 对账：`office_memory_run` 新增行 + DM8 幂等（第二次触发应记 no-op）。
  if (state.runRows.length === 0) {
    push('run-rows', '蒸馏对账行（office_memory_run）', 'pending', '基线之后一行新账都没落 ⇒ 蒸馏没跑')
    push('dm8-idempotent', '重跑幂等（DM8：第二次应 no-op）', 'pending', '一行账都没有 ⇒ 还没到能验幂等的地步')
  } else {
    const summary = state.runRows
      .map(row => `${row.runId} outcome=${row.outcome} promoted=${String(row.promoted)} archived=${String(row.archived)} indexLines=${String(row.indexLines)} guardedSkips=${String(row.guardedSkips)} wm=${String(row.watermarkFrom)}→${row.watermarkTo}`)
      .join(' | ')
    const hasDistilled = state.runRows.some(row => row.outcome === 'distilled')
    push('run-rows', '蒸馏对账行（office_memory_run）', hasDistilled ? 'pass' : 'fail',
      `新增 ${String(state.runRows.length)} 行：${summary}`)
    const last = state.runRows.at(-1)
    push('dm8-idempotent', '重跑幂等（DM8：第二次应 no-op）',
      last === undefined || state.runRows.length < 2 ? 'pending' : last.outcome === 'no-op' ? 'pass' : 'fail',
      last === undefined || state.runRows.length < 2 ? '只有 1 行 ⇒ 再触发一次 memory_distill 才算验过' : `最后一行 outcome=${last.outcome}`)
  }

  // ⑩ 第 5 枪（重启一次看幂等）的可计算版本：**标记说的那一个 jobId** 与 **调度层实际挂着的夜间任务行** 必须
  //    是同源的一条。堆叠（>1 行）＝这一夜会被叫醒多次；标记在场而行没了＝nightly 永不点火、`armed-marker`
  //    却照报绿。方向按老口径：什么都没武装算 pending，一旦「标记与调度层各说各话」就是 fail。
  const schedule = state.schedule
  const describeRow = (row: NightlyJobRow): string =>
    `${row.jobId}（会话 ${row.sessionId}，${row.kind} ${row.time || '?'} ${row.timeZone || '?'}，status=${row.status}，已点火 ${String(row.deliveries)} 次，下次 ${row.scheduledAt || '?'}）`
  const onlyRow = schedule.rows.find(row => row.jobId === state.armedJob)
  const shapeProblems = onlyRow === undefined ? []
    : [
        ...(onlyRow.kind !== 'daily' ? [`kind=${onlyRow.kind}（要 daily）`] : []),
        ...(onlyRow.time !== DISTILL_TIME ? [`time=${onlyRow.time || '(空)'}（要 ${DISTILL_TIME}）`] : []),
        ...(onlyRow.timeZone !== DISTILL_TIME_ZONE ? [`timeZone=${onlyRow.timeZone || '(空)'}（要 ${DISTILL_TIME_ZONE}）`] : []),
        ...(onlyRow.status !== 'active' ? [`status=${onlyRow.status}（到点不会再点火）`] : []),
      ]
  if (state.armedJob === undefined) {
    push('nightly-job-single', '夜间任务与武装标记同源且只有一条（MF4／第 5 枪）',
      schedule.rows.length === 0 ? 'pending' : 'fail',
      schedule.rows.length === 0
        ? `调度层里没有夜间蒸馏任务行、标记也不在场 ⇒ 还没武装（第 1 枪的顶层会话没开）〔${input.scheduleFile}：${schedule.exists ? `共 ${String(schedule.totalTasks)} 行任务` : '文件不在场'}〕`
        : `调度层挂着 ${String(schedule.rows.length)} 条夜间蒸馏任务而标记不在场 ⇒ 03:30 会叫醒一个没人观测的蒸馏：${schedule.rows.map(describeRow).join('; ')}`)
  } else if (!schedule.exists) {
    push('nightly-job-single', '夜间任务与武装标记同源且只有一条（MF4／第 5 枪）', 'fail',
      `标记说 jobId=${state.armedJob}，但 ${input.scheduleFile} 不在场 ⇒ 任务从没落到调度层（数据根不是这里就传 --schedule-file）`)
  } else if (schedule.error !== '') {
    push('nightly-job-single', '夜间任务与武装标记同源且只有一条（MF4／第 5 枪）', 'fail', schedule.error)
  } else if (onlyRow === undefined) {
    push('nightly-job-single', '夜间任务与武装标记同源且只有一条（MF4／第 5 枪）', 'fail',
      schedule.rows.length === 0
        ? `标记 jobId=${state.armedJob}，但调度层里没有任何夜间蒸馏任务行（共 ${String(schedule.totalTasks)} 行任务）⇒ 任务已被取消，nightly 永不点火`
        : `标记 jobId=${state.armedJob} 不在夜间任务行里 ⇒ 标记与调度层各说一件事：${schedule.rows.map(describeRow).join('; ')}`)
  } else if (schedule.rows.length > 1) {
    push('nightly-job-single', '夜间任务与武装标记同源且只有一条（MF4／第 5 枪）', 'fail',
      `调度层挂着 ${String(schedule.rows.length)} 条夜间蒸馏任务 ⇒ 重启堆叠或上一夜残留：${schedule.rows.map(describeRow).join('; ')}`)
  } else if (shapeProblems.length > 0) {
    push('nightly-job-single', '夜间任务与武装标记同源且只有一条（MF4／第 5 枪）', 'fail',
      `${describeRow(onlyRow)} ⇒ ${shapeProblems.join('，')}`)
  } else {
    push('nightly-job-single', '夜间任务与武装标记同源且只有一条（MF4／第 5 枪）', 'pass',
      `${describeRow(onlyRow)}；调度层共 ${String(schedule.totalTasks)} 行任务，其中夜间蒸馏只有这一条`)
  }
  return verdicts
}

export function summarize(verdicts: readonly Verdict[]): { readonly exitCode: number, readonly counts: Record<VerdictStatus, number> } {
  const counts: Record<VerdictStatus, number> = { pass: 0, fail: 0, pending: 0, info: 0 }
  verdicts.forEach(verdict => { counts[verdict.status] += 1 })
  return { exitCode: counts.fail > 0 ? 1 : counts.pending > 0 ? 3 : 0, counts }
}

// —— CLI ——
const MARK: Record<VerdictStatus, string> = { pass: '✓', fail: '×', pending: '·', info: '!' }

function argValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 || process.argv[index + 1] === undefined ? fallback : process.argv[index + 1]
}

// CLI 守卫按**精确文件名**判：`selftest-verify-step6.ts` 也endsWith `verify-step6.ts`，
// 用后缀判会让自证一 import 这个模块就走进 CLI 分支（这一枪就是那么被抓出来的）。
const isCli = process.argv[1] !== undefined && path.basename(process.argv[1]) === 'verify-step6.ts'
if (isCli) {
  const memoryDir = process.argv[2] ?? ''
  if (memoryDir === '' || !fs.existsSync(path.join(memoryDir, 'MEMORY.md'))) {
    console.error('用法：node --import tsx/esm "../apps/fom-client/.spike/verify-step6.ts" <memoryDir> --baseline <file> [--out <file>] [--requests-dir <dir>] [--runs-dir <dir>] [--cards-expected <n>] [--schedule-file <file>]')
    console.error('（memoryDir 里得有 MEMORY.md —— 先跑 .spike/seed-distill.mjs）')
    process.exit(2)
  }
  const baselineFile = argValue('baseline', '')
  if (baselineFile === '' || !fs.existsSync(baselineFile)) {
    console.error(`没有基线文件 ${baselineFile === '' ? '（--baseline 必填）' : baselineFile} —— 它由 .spike/run-step6.mjs 在起进程时写出`)
    process.exit(2)
  }
  const expectFile = path.join(memoryDir, '.seed-expect.json')
  const input: VerifyInput = {
    memoryDir,
    baseline: JSON.parse(fs.readFileSync(baselineFile, 'utf8')) as Baseline,
    expect: fs.existsSync(expectFile) ? JSON.parse(fs.readFileSync(expectFile, 'utf8')) as SeedExpectation : null,
  requestsDir: argValue('requests-dir', 'C:/Users/EDY/.dsh/storages/office_approval_ledger/requests'),
  // F-6A：蒸馏进程跑在自己的 DSH_HOME（`C:/Users/EDY/.dsh-distill`）⇒ 它的 run 台账与 schedule.json 都在那儿。
  runsDir: argValue('runs-dir', 'C:/Users/EDY/.dsh-distill/storages/office_memory_run/runs'),
  scheduleFile: argValue('schedule-file', 'C:/Users/EDY/.dsh-distill/storages/schedule.json'),
    cardsExpected: Number(argValue('cards-expected', '0')),
  }
  const verdicts = await computeVerdicts(input)
  verdicts.forEach(verdict => { console.log(`  ${MARK[verdict.status]} [${verdict.id}] ${verdict.label} — ${verdict.detail}`) })
  const { exitCode, counts } = summarize(verdicts)
  console.log(`\npass=${String(counts.pass)} fail=${String(counts.fail)} pending=${String(counts.pending)} info=${String(counts.info)} ⇒ exit=${String(exitCode)}`)
  const outFile = argValue('out', '')
  if (outFile !== '') {
    fs.writeFileSync(outFile, `${JSON.stringify({ checkedAt: new Date().toISOString(), memoryDir, exitCode, counts, verdicts }, null, 2)}\n`, 'utf8')
    console.log(`判定快照已写 ${outFile}`)
  }
  process.exit(exitCode)
}
