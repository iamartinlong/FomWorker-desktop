/**
 * `verify-step6.ts` 那台判据计算机的**自证**：它自己就是第 6 步的判据来源，所以它得先被证明
 * 「该绿的会绿、被踩雷时会红」——否则观测当天人在场看到的 ✓ 只是排版的产物。
 *
 * 做法：把 `.spike/distill-workspace` 的种子**拷**到临时目录（绝不碰真观测现场），用第 5 步那套真代码
 * （`distillOnce` + 真 `storage-json` 台账，与 `distill.spec.ts` 同一装法）在拷贝上造出「观测后」态，
 * 然后逐例断言每条判定的状态。起手基线**由启动器用的那个生产者 `step6-baseline.mjs` 现算**（②r：这里原先手搓一份
 * 基线对象，等于同一段读法抄三遍，「判据能否读回生产者产的那份基线」从来没被验过）。例子里正向的是（起手态 / 蒸馏一次 /
 * 再蒸馏一次 / 标记与调度层同源的一条），其余是反向（手写索引留悬空行、条目里带凭据、手改靶正文被动、蒸馏侧多出一张审批卡、
 * 调度层那一侧的各种坏形状——堆叠、行没了、文件不在场、形状不符、任务残留而标记丢了、文档读不成；
 * 以及差值两端不同源：日级少了一天、`daily/` 里混进目录形状的日子、索引含非法 UTF-8、两时点之间手改靶换了文件、
 * 旁证里靶清单为空）—— 反向那些是**判定层的变异检验**：对应守卫被踩时判定必须变红，不然这条判据等于没写。
 *
 * ⚠️ 全程不起产品进程、不产生模型回合，所以它证明的是**判据计算**，不是第 6 步的观测本身。
 * 真进程那一夜仍需本人在场（task #43）。
 *
 * 跑法（`--import tsx/esm` 需要内核那份 tsx，所以在内核根执行；裸包名按文件所在目录解析到 office-platform 的 junction）：
 *   cd ../deepseek-harness && node --import tsx/esm \
 *     "../apps/fom-client/.spike/selftest-verify-step6.ts" <seedDir>
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { MemoryStore } from '../plugins/office-memory/store.ts'
import { distillOnce } from '../plugins/office-memory/distill.ts'
import { MemoryRunLedger, memoryRunDomain } from '../plugins/office-memory/run-ledger.ts'
import { type JobSpec, writeSchedule } from './schedule-fixture.ts'
import { buildBaseline } from './step6-baseline.mjs'
import { computeVerdicts, summarize, type Baseline, type Verdict, type VerdictStatus } from './verify-step6.ts'

const seedDir = process.argv[2] ?? ''
if (seedDir === '' || !fs.existsSync(path.join(seedDir, '.seed-expect.json'))) {
  console.error(`用法：node --import tsx/esm "../apps/fom-client/.spike/selftest-verify-step6.ts" <seedDir>（要一个已种好的目录）`)
  process.exit(2)
}

// 与 `check-seed.ts` 同一个挂钟约定：种子里的 createdAt 是写死的，判定与蒸馏必须对着同一时刻算。
const CLOCK = Date.parse('2026-11-01T03:30:00.000Z')
const DAY_MS = 86_400_000

const contexts: Context[] = []
const works: string[] = []

interface World {
  readonly memories: string
  readonly requests: string
  readonly runs: string
  readonly scheduleFile: string
  readonly ledger: MemoryRunLedger
  baseline: Baseline
}

/**
 * 调度层那一侧的例子全部通过 `./schedule-fixture.ts` 这个**唯一生产者**写盘（默认取 `arm.ts` 的常量，
 * 与真武装出来的那一行逐字相同；反向例只覆盖它要踩坏的那一列）。这里不再另抄一份内核形状。
 */

/** 装出「标记指向的那条任务确实挂在调度层」的自洽态（第 5 枪重启后的样子）。 */
async function armConsistently(world: World, jobId = 'job-nightly-1'): Promise<void> {
  await new MemoryStore(world.memories, { now: () => CLOCK }).writeArmedJob(jobId)
  writeSchedule(world.scheduleFile, [{ jobId }])
}

/** 拷一份种子 + 建一个空 requests 目录，并按启动器那套算法现算起手基线。 */
async function freshWorld(): Promise<World> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'step6-selftest-'))
  works.push(work)
  const memories = path.join(work, 'memories')
  fs.cpSync(seedDir, memories, { recursive: true })
  const requests = path.join(work, 'requests')
  fs.mkdirSync(requests)
  const storageRoot = path.join(work, 'storage')
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: storageRoot })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  // 域只能在一个 Context 上 open 一次（内核抛 `already-open`）：ledger 建在这里、随 World 传下去。
  const ledger = new MemoryRunLedger(await ctx.storageDomain.open(memoryRunDomain))
  const runs = path.join(storageRoot, 'office_memory_run', 'runs')
  const world: World = {
    memories,
    requests,
    runs,
    // 起手不写这个文件：临时世界里没有调度层文档 ⇒ 第 1 例验「什么都没武装算 pending」，
    // 而「标记在场、文件不在场」那一例只需补一个标记。
    scheduleFile: path.join(work, 'schedule.json'),
    ledger,
    // 基线**只能由启动器用的那个生产者产**：这里原先手搓一份对象（自己算 sha、自己写死手改靶路径、自己列日级），
    // 于是「判据对基线的读法」从来没被验过 —— 与 ②k 抽生产者要消灭的是同一个缺陷，只是第三处落点。
    baseline: buildBaseline({
      memoryDir: memories,
      requestsDir: requests,
      runsDir: runs,
      takenAt: new Date(CLOCK).toISOString(),
    }) as Baseline,
  }
  return world
}

/**
 * 把基线**按当前盘**重算一遍：用于「晚上落的那份基线本来就描述这个状态」的例（如非法 UTF-8 的索引没被动过）。
 * 走的是同一个生产者，所以这一句同时保证了「重算出来的基线与判据读当前盘用的是同一套表达式」。
 */
function rebaseline(world: World): void {
  world.baseline = buildBaseline({
    memoryDir: world.memories,
    requestsDir: world.requests,
    runsDir: world.runs,
    takenAt: new Date(CLOCK).toISOString(),
  }) as Baseline
}

async function judge(world: World, cardsExpected = 0): Promise<Map<string, Verdict>> {
  const verdicts = await computeVerdicts({
    memoryDir: world.memories,
    baseline: world.baseline,
    expect: JSON.parse(fs.readFileSync(path.join(world.memories, '.seed-expect.json'), 'utf8')) as {
      expected?: { mustSurviveInIndex?: readonly string[], mustVanishFromIndex?: readonly string[] }
    },
    requestsDir: world.requests,
    runsDir: world.runs,
    scheduleFile: world.scheduleFile,
    cardsExpected,
    now: () => CLOCK,
  })
  return new Map(verdicts.map(verdict => [verdict.id, verdict]))
}

async function distill(world: World, at: number): Promise<void> {
  await distillOnce({ store: new MemoryStore(world.memories, { now: () => at }), ledger: world.ledger }, { now: () => at })
}

let failures = 0
let passes = 0
function expectStatuses(label: string, verdicts: Map<string, Verdict>, expected: Record<string, VerdictStatus>): void {
  const wrong: string[] = []
  Object.entries(expected).forEach(([id, status]) => {
    const verdict = verdicts.get(id)
    if (verdict === undefined) wrong.push(`${id}=缺失`)
    else if (verdict.status !== status) wrong.push(`${id}=${verdict.status}（应为 ${status}）`)
  })
  const summary = summarize([...verdicts.values()])
  if (wrong.length > 0) {
    failures += 1
    console.log(`× ${label} — 判定不符：${wrong.join(', ')}`)
    verdicts.forEach(verdict => { console.log(`    [${verdict.id}] ${verdict.status} ${verdict.detail}`) })
  } else {
    passes += 1
    console.log(`✓ ${label} — ${Object.keys(expected).length} 条判定符合预期（exit=${String(summary.exitCode)}）`)
  }
}

/**
 * 补充断言（状态之外的第二问）。绿的那一面也必须留痕：只往 `failures` 加数、不打印成功行的断言，
 * 与「`EXIT=0` 加零输出＝没跑」是同一个坑 —— 读日志的人没法证明这一问真被问过。
 */
function expectExtra(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passes += 1
    console.log(`✓ ${label}`)
  } else {
    failures += 1
    console.log(`× ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

/** 红例除了状态对，还要说出**该去核哪一层**：原因错了，观测当天就会去做错的动作（去重装任务 vs 改路径）。 */
function expectDetail(label: string, verdicts: Map<string, Verdict>, id: string, needles: readonly string[]): void {
  const detail = verdicts.get(id)?.detail ?? ''
  const missing = needles.filter(needle => !detail.includes(needle))
  expectExtra(label, missing.length === 0, `详情里缺 ${missing.join(' / ')}：${detail.slice(0, 160)}`)
}

// ① 起手态：什么都还没发生 ⇒ 只有「已经成立」的那几条能绿，其余必须是 pending，一条都不许 fail。
{
  const world = await freshWorld()
  const verdicts = await judge(world)
  expectStatuses('① 起手态（观测未跑）', verdicts, {
    'armed-marker': 'pending',
    'member-appended-daily': 'pending',
    'daily-append-only': 'pass',
    'daily-readers-agree': 'pass',
    'index-rebuilt': 'pending',
    'planted-ghost-gone': 'pending',
    'watermark-advanced': 'pending',
    'hand-edited-untouched': 'pass',
    'must-survive-in-index': 'pending',
    'no-secret-in-memory': 'pending',
    'zero-cards-from-distiller': 'pass',
    'run-rows': 'pending',
    'dm8-idempotent': 'pending',
    'nightly-job-single': 'pending',
  })
  expectExtra('①b 起手态一条 fail 都没有',
    ![...verdicts.values()].some(verdict => verdict.status === 'fail'),
    `出现 fail：${[...verdicts.values()].filter(verdict => verdict.status === 'fail').map(verdict => `${verdict.id}（${verdict.detail.slice(0, 80)}）`).join('; ')} ⇒ 判定把「还没发生」读成了「被违反」`)
}

// ② 蒸馏一次：ME10 整段重建、已知雷消失、水位线前移、对账落行、零卡、手改靶原封不动。
{
  const world = await freshWorld()
  await distill(world, CLOCK)
  const verdicts = await judge(world)
  expectStatuses('② 蒸馏一次后', verdicts, {
    'index-rebuilt': 'pass',
    'planted-ghost-gone': 'pass',
    'watermark-advanced': 'pass',
    'hand-edited-untouched': 'pass',
    'must-survive-in-index': 'pass',
    'no-secret-in-memory': 'pass',
    'zero-cards-from-distiller': 'pass',
    'run-rows': 'pass',
    'dm8-idempotent': 'pending',
  })
}

// ③ 再触发一次：DM8 的幂等就是这一条 —— 第二次记 no-op，且不许把第一条的结论冲掉。
{
  const world = await freshWorld()
  await distill(world, CLOCK)
  await distill(world, CLOCK + DAY_MS)
  const verdicts = await judge(world)
  expectStatuses('③ 第二次触发（DM8 幂等）', verdicts, {
    'dm8-idempotent': 'pass',
    'run-rows': 'pass',
    'watermark-advanced': 'pass',
    'index-rebuilt': 'pass',
  })
}

// ④ 反向：模拟「增量更新留下悬空行」——ME10 要避免的失败形态，判定必须变红。
{
  const world = await freshWorld()
  await distill(world, CLOCK)
  fs.appendFileSync(path.join(world.memories, 'MEMORY.md'), '- [手写的幽灵](project/ghost-manual.md) — 假装增量更新留下的行\n', 'utf8')
  const verdicts = await judge(world)
  expectStatuses('④ 反向：索引里有悬空行', verdicts, { 'index-rebuilt': 'fail' })
}

// ⑤ 反向：条目正文里出现凭据形态（V4 投毒被提炼进长期记忆）。写侧守卫 ME7 本来会拒这个形状，
//    这一枪验的是「万一绕过工具直接落盘，判定层这张网还在」。
{
  const world = await freshWorld()
  await distill(world, CLOCK)
  const store = new MemoryStore(world.memories, { now: () => CLOCK })
  const written = await store.writeEntry({
    type: 'project', slug: 'selftest-poison', title: '自证用的条目', hook: '正文后面追加凭据形态',
    body: '正文本身干净。', source: 'session',
  })
  fs.appendFileSync(path.join(world.memories, written.relativePath), '\nops_password: FAKE-SELFTEST-VALUE-0003\n', 'utf8')
  const verdicts = await judge(world)
  expectStatuses('⑤ 反向：条目里带凭据', verdicts, { 'no-secret-in-memory': 'fail' })
  const hit = (verdicts.get('no-secret-in-memory')?.detail ?? '')
  expectExtra('⑤b 判定只报位置与模式名，不报凭据字面', !hit.includes('FAKE-SELFTEST-VALUE-0003'),
    '判定把凭据**字面**打印出来了 ⇒ 违反「只记位置不记字面值」（红例也不回显详情，回显就是二次外泄）')
}

// ⑥ 反向：手改靶的正文被动过（蒸馏改了人手改的内容）。靶路径取自基线，不在这里另写第四遍。
{
  const world = await freshWorld()
  await distill(world, CLOCK)
  const target = path.join(world.memories, String(world.baseline.handEditedTarget))
  fs.appendFileSync(target, '\n这一行是蒸馏不该动的人写的补充\n', 'utf8')
  const verdicts = await judge(world)
  expectStatuses('⑥ 反向：手改靶正文被动', verdicts, { 'hand-edited-untouched': 'fail' })
}

// ⑦ 反向：蒸馏那一侧多出一张审批卡＝ME8 破产；同时验「本人声明了成员臂该出 1 张」时的归属判定。
{
  const world = await freshWorld()
  await distill(world, CLOCK)
  fs.writeFileSync(path.join(world.requests, 'card-from-distiller.json'), '{"note":"占位：判定只认文件名集合，不读正文"}\n', 'utf8')
  const verdicts = await judge(world)
  expectStatuses('⑦ 反向：凭空多一张审批卡', verdicts, { 'zero-cards-from-distiller': 'fail' })
  const declared = await judge(world, 1)
  expectStatuses('⑦b 同一张卡被声明为成员臂所出', declared, { 'zero-cards-from-distiller': 'pass' })
}

// ⑧ 正向（第 5 枪重启后的自洽态）：标记指向的 jobId 就是调度层里唯一那条夜间任务。
{
  const world = await freshWorld()
  await armConsistently(world)
  const verdicts = await judge(world)
  expectStatuses('⑧ 标记与调度层同源且只有一条', verdicts, {
    'nightly-job-single': 'pass',
    'armed-marker': 'pass',
  })
}

// ⑧b 正向：那一行没写 `status` 列（schema 里带 default）⇒ 不能因为它缺列就报红。
//     这台机器上真文档的 39 行**都**写了 status，所以这一支只有合成例能走到；留着它是防误红，不是防误绿。
{
  const world = await freshWorld()
  await new MemoryStore(world.memories, { now: () => CLOCK }).writeArmedJob('job-nightly-1')
  writeSchedule(world.scheduleFile, [{ jobId: 'job-nightly-1', status: null }])
  const verdicts = await judge(world)
  expectStatuses('⑧b 正向：那一行没写 status 列', verdicts, { 'nightly-job-single': 'pass' })
}

// ⑧c 正向：调度层里同时挂着**别人的**一次性任务（审批催办那种 `at` 形，真文档 39 行全是这一形）
//     ⇒ 归属只认标题/正文与 `arm.ts` 常量逐字相等的那几行，别人多不能把我这条挤成「堆叠」。
{
  const world = await freshWorld()
  await armConsistently(world)
  writeSchedule(world.scheduleFile, [
    { jobId: 'job-urge-1', shape: 'at', title: '审批催办', prompt: '另一段正文' },
    { jobId: 'job-nightly-1' },
    { jobId: 'job-urge-2', shape: 'at', title: '审批过期', prompt: '又一段正文' },
  ])
  const verdicts = await judge(world)
  expectStatuses('⑧c 正向：调度层混着别人的任务', verdicts, { 'nightly-job-single': 'pass' })
}

// ⑨ 反向：重启堆叠（幂等标记丢了 ⇒ 调度层挂着两条夜间任务）⇒ 03:30 被叫醒两次。
//    detail 必须把两条都点名，否则观测当天只看到一个数字、不知道多余的是哪一条。
{
  const world = await freshWorld()
  await new MemoryStore(world.memories, { now: () => CLOCK }).writeArmedJob('job-old')
  writeSchedule(world.scheduleFile, [{ jobId: 'job-old' }, { jobId: 'job-new' }])
  const verdicts = await judge(world)
  expectStatuses('⑨ 反向：调度层堆了两条夜间任务', verdicts, { 'nightly-job-single': 'fail' })
  expectDetail('⑨b 堆叠的那两条都被逐行列名', verdicts, 'nightly-job-single', ['job-old', 'job-new'])
}

// ⑩ 反向：任务被取消（内核真删行、没有墓碑）而标记还在 ⇒ nightly 永不点火。
//    这一例同时钉住「为什么不能只看标记」：`armed-marker` 在这里照报绿。
{
  const world = await freshWorld()
  await armConsistently(world)
  writeSchedule(world.scheduleFile, [])
  const verdicts = await judge(world)
  expectStatuses('⑩ 反向：标记在场而任务行没了', verdicts, {
    'nightly-job-single': 'fail',
    'armed-marker': 'pass',
  })
  expectDetail('⑩b 红例说出「任务被取消」这一因（与「文档读不成」不混成一句）', verdicts, 'nightly-job-single', ['取消'])
}

// ⑪ 反向：标记说 jobId=X，但传进来的那份调度层文档根本不在场（数据根不是这里）。
//    不能把它读成「没武装」——那是 pending；这是「观测用了错的路径」，必须拦。
{
  const world = await freshWorld()
  await new MemoryStore(world.memories, { now: () => CLOCK }).writeArmedJob('job-x')
  const verdicts = await judge(world)
  expectStatuses('⑪ 反向：标记在场而调度层文件不在场', verdicts, { 'nightly-job-single': 'fail' })
  expectDetail('⑪b 红例指向「路径拿错」这个动作（而不是让人去重装任务）', verdicts, 'nightly-job-single', ['--schedule-file'])
}

// ⑫ 反向：调度层那一行的形状与 `arm.ts` 的常量不符（四列各一例，不合成一条）。
//     拆开的理由是变异检验：把某一列的比较改坏时，另外三列的例子会替它作证、于是只有一个存活。
{
  const shapes: { label: string, spec: JobSpec }[] = [
    { label: 'kind 不是 daily', spec: { jobId: 'job-x', kind: 'cron' } },
    { label: 'time 走偏', spec: { jobId: 'job-x', time: '04:30:00.000' } },
    { label: 'timeZone 走偏', spec: { jobId: 'job-x', timeZone: 'UTC' } },
    { label: 'status 不是 active', spec: { jobId: 'job-x', status: 'inactive' } },
  ]
  for (const shape of shapes) {
    const world = await freshWorld()
    await new MemoryStore(world.memories, { now: () => CLOCK }).writeArmedJob('job-x')
    writeSchedule(world.scheduleFile, [shape.spec])
    const verdicts = await judge(world)
    expectStatuses(`⑫ 反向：调度层那一行 ${shape.label}`, verdicts, { 'nightly-job-single': 'fail' })
  }
}

// ⑬ 反向：调度层挂着夜间任务而标记不在场（标记文件被手删／换机器只搬了调度层）⇒ 到点会叫醒
//     一个没人观测的蒸馏会话。这一支必须是 fail 而不是 pending：pending 只留给「两头都空」。
{
  const world = await freshWorld()
  writeSchedule(world.scheduleFile, [{ jobId: 'job-orphan' }])
  const verdicts = await judge(world)
  expectStatuses('⑬ 反向：任务残留而标记不在场', verdicts, {
    'nightly-job-single': 'fail',
    'armed-marker': 'pending',
  })
}

// ⑭ 反向：调度层文档读不成（半截 JSON）。这一支的红要说清是「读不成」，不能和「行没了」混成一句。
{
  const world = await freshWorld()
  await new MemoryStore(world.memories, { now: () => CLOCK }).writeArmedJob('job-x')
  fs.writeFileSync(world.scheduleFile, '{"unit":{"name":"schedule","vers', 'utf8')
  const verdicts = await judge(world)
  expectStatuses('⑭ 反向：调度层文档不是合法 JSON', verdicts, { 'nightly-job-single': 'fail' })
  expectDetail('⑭b 红例说出「读不成」这一因（不会被当成「调度层里真没有夜间任务」）', verdicts, 'nightly-job-single', ['JSON'])
}

// ⑮ 反向：基线里有的一天从 `daily/` 消失了。DM8 的幂等前提是「已蒸过的日级还在」，所以这一支必须是 fail，
//     不能像「新增」那样退回 pending —— 水位线一旦推过那天，它的内容再没有语料可生成。
{
  const world = await freshWorld()
  fs.rmSync(path.join(world.memories, 'daily/2026-10-09.md'))
  const verdicts = await judge(world)
  expectStatuses('⑮ 反向：日级流水少了一天', verdicts, {
    'daily-append-only': 'fail',
    'member-appended-daily': 'pending',
  })
  expectDetail('⑮b 红例点名少的是哪一天（只报「少了」＝观测当天不知道去核哪个文件）', verdicts, 'daily-append-only', ['2026-10-09'])
}

// ⑯ 反向：`daily/` 里混进一个「日子形状的目录」。基线/判据按**名字**算日级，产品 store 还要求是普通文件，
//     于是「成员那一枪打没打」这件事，观测者看到的清单与蒸馏进程看到的清单不是同一份。
{
  const world = await freshWorld()
  fs.mkdirSync(path.join(world.memories, 'daily/2026-12-31.md'))
  const verdicts = await judge(world)
  expectStatuses('⑯ 反向：daily/ 里有一个目录形状的日子', verdicts, {
    'daily-readers-agree': 'fail',
    'daily-append-only': 'pass',
  })
  expectDetail('⑯b 红例点名是哪一边看到的（两边不点名就没法判断是残留还是漏读）', verdicts, 'daily-readers-agree',
    ['只有基线读法看到：2026-12-31', '只有产品 store 看到：(无)'])
}

// ⑰ 反向语料：索引里有非法 UTF-8 字节而**一字节没动** ⇒ 不许凭空算出「蒸馏跑过了」。
//     哈希基准（字节 vs 解码后的串）只有在这种语料上才分得开，所以这一例自带「语料真能分开两种基准」的自检：
//     没有那条自检，例子可能一直在验一个不存在的差异（②i 那条「反向语料要真能区分」纪律）。
{
  const world = await freshWorld()
  const indexFile = path.join(world.memories, 'MEMORY.md')
  fs.appendFileSync(indexFile, Buffer.from([0xff, 0xfe, 0x00, 0x41, 0x0a]))
  const bytes = fs.readFileSync(indexFile)
  const sha = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')
  const byteSha = sha(bytes)
  const stringSha = sha(Buffer.from(bytes.toString('utf8'), 'utf8'))
  expectExtra('⑰a 这份语料确实能分开两种哈希基准（字节 sha ≠ 解码串 sha）', byteSha !== stringSha,
    '两种基准算出同一个 sha ⇒ 这一例验的是一个不存在的差异，换语料重做')
  rebaseline(world)
  const verdicts = await judge(world)
  expectStatuses('⑰ 反向：索引含非法 UTF-8 但没被动过 ⇒ 不许报「sha 变了」', verdicts, { 'index-rebuilt': 'pending' })
}

// ⑱ 反向：`.seed-expect.json` 在两时点之间被改过 ⇒ 晚上记的靶与早上解析的靶不是同一个文件。
//     这时这条判定比的两个 sha 分属两个文件，无论红绿都不说明蒸馏动了什么，必须先拦下来。
{
  const world = await freshWorld()
  await distill(world, CLOCK)
  const expect = JSON.parse(fs.readFileSync(path.join(world.memories, '.seed-expect.json'), 'utf8')) as Record<string, unknown>
  expect.handEditedEntries = ['user/role.md']
  fs.writeFileSync(path.join(world.memories, '.seed-expect.json'), `${JSON.stringify(expect, null, 2)}\n`, 'utf8')
  const verdicts = await judge(world)
  expectStatuses('⑱ 反向：两时点之间手改靶换了文件', verdicts, { 'hand-edited-untouched': 'fail' })
  expectDetail('⑱b 红例把「晚上记的」与「现在解析的」两个路径都点名', verdicts, 'hand-edited-untouched',
    ['reference/hand-edited-guard.md', 'user/role.md', '.seed-expect.json'])
}

// ⑲ 反向（旧形状的崩溃面）：旁证把 `handEditedEntries` 写成空数组。判据原先自己解析这份旁证，
//     `(expect.handEditedEntries ?? [...])[0]` 得到 `undefined` ⇒ `path.join` 当场抛 TypeError，
//     早上整张表崩成一坨栈、一条判定都不出。现在两端共用生产者的解析器（带形状守卫），靶退回经典路径、判定照旧出。
{
  const world = await freshWorld()
  await distill(world, CLOCK)
  const expect = JSON.parse(fs.readFileSync(path.join(world.memories, '.seed-expect.json'), 'utf8')) as Record<string, unknown>
  expect.handEditedEntries = []
  fs.writeFileSync(path.join(world.memories, '.seed-expect.json'), `${JSON.stringify(expect, null, 2)}\n`, 'utf8')
  const verdicts = await judge(world)
  expectStatuses('⑲ 反向：旁证里靶清单为空 ⇒ 不崩、靶退回经典路径且判定照旧出', verdicts, { 'hand-edited-untouched': 'pass' })
}

for (const ctx of contexts) await ctx.fiber.dispose()
for (const work of works) fs.rmSync(work, { recursive: true, force: true })

if (failures > 0) {
  console.log(`\nFAIL：${String(failures)} 项判定不符`)
  process.exit(1)
}
console.log(`\nPASS verify-step6 判定自证（${String(passes)} ✓ / ${String(failures)} ✗：判定层自身 + 夜间任务对账 + ②r 差值两端同源对账，正向与反向臂都在内；基线由 step6-baseline.mjs 现算，真 distillOnce + 真 storage-json 台账，临时目录已清理）`)
