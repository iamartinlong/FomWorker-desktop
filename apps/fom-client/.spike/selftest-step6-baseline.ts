/**
 * 第 6 步「起手基线」这条**契约**的端到端自证：生产者（`step6-baseline.mjs`，启动器起完两个进程后调它）
 * 写出的那份 JSON 喂给消费者（`verify-step6.ts`，早上算判定那台）必须得出**起手态该有的判定** ——
 * 一条 fail 都不许有，退出码是 `3`（待观测）而不是 `2`（用法错）。
 *
 * 为什么要有这个文件：第 6 步的观测是分离的两次在场（晚上起进程 / 早上收账），中间唯一的桥就是这份
 * `step6-baseline.json`，而它此前从没被端到端跑过 —— 启动器只在真起进程（需本人在场）时才写它，
 * `selftest-verify-step6.ts` 则自己手搓一份基线对象喂进去。**两边各写一遍同一段算法就迟早漂**；
 * 抽成一份生产者时当场漂出两处：手改靶路径被写死（消费端却按 `.seed-expect.json` 解析目标）、
 * 水位线文件缺失时 ENOENT 崩在两个冷启动之后。漂移的后果不是报错，是**整夜观测白跑**：判定把
 * 「还没发生」读成「被违反」，或反过来把「被违反」读成绿。
 *
 * 各例盯「生产者 ↔ 消费者」这条接缝；判定层内部逻辑（蒸馏后该绿、被踩雷该红）由
 * `selftest-verify-step6.ts` 覆盖。⚠️ ②r 之后两端**共用**同一批读法，于是「两端同值」这类关系断言会随两端一起漂：
 * 生产端自己的口径（哈希基准、缺文件的行为）另由 ①b 那组**绝对锚**钉住 —— 用的是不共用 `sha256File` 的表达式；
 * 而生产端硬编码的那四个**文件名**（`daily/.watermark`、`daily/.distill-armed`、`MEMORY.md`、`daily/`）归 `store.ts`
 * 的私有常量所有、`.mjs` 又 import 不到 `.ts`，所以 ⑨ 反过来走一遍钉住它们：真 store 写、生产端读（②s）。
 * 全程不起产品进程、不产生模型回合、不读 `.dsh`（requests/runs 与
 * 调度层文档都用临时路径 —— 后者缺省值是真机器的 `schedule.json`，漏传不会报错，只会静默读到别人的行）。
 *
 * 跑法（`--import tsx/esm` 需要内核那份 tsx，所以在内核根执行）：
 *   cd ../deepseek-harness && node --import tsx/esm \
 *     "../apps/fom-client/.spike/selftest-step6-baseline.ts" <seedDir>
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildBaseline, handEditedTarget, readWatermark, sha256File } from './step6-baseline.mjs'
import { computeVerdicts, summarize, type Baseline, type Verdict } from './verify-step6.ts'
import { DISTILL_PROMPT, DISTILL_TIME, DISTILL_TIME_ZONE, DISTILL_TITLE } from '../plugins/office-memory/arm.ts'
import { INDEX_HEADER, MemoryStore } from '../plugins/office-memory/store.ts'

const seedDir = process.argv[2] ?? ''
if (seedDir === '' || !fs.existsSync(path.join(seedDir, '.seed-expect.json'))) {
  console.error('用法：node --import tsx/esm "../apps/fom-client/.spike/selftest-step6-baseline.ts" <seedDir>（要一个已种好的目录）')
  process.exit(2)
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VERIFY = path.join(HERE, 'verify-step6.ts')
const KERNEL = path.resolve(HERE, '..', '..', 'deepseek-harness')

let failures = 0
let passes = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || detail === '' ? '' : ` — ${detail}`}`)
  if (ok) passes += 1
  else failures += 1
}

interface World {
  readonly memories: string
  readonly requests: string
  readonly runs: string
  readonly scheduleFile: string
  readonly baseline: Baseline
}

const works: string[] = []

/** 拷一份种子到临时目录（绝不碰真观测现场），再用**启动器那同一份生产者**现算基线。 */
function freshWorld(): World {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'step6-seam-'))
  works.push(work)
  const memories = path.join(work, 'memories')
  fs.cpSync(seedDir, memories, { recursive: true })
  const requests = path.join(work, 'requests')
  const runs = path.join(work, 'runs')
  fs.mkdirSync(requests)
  fs.mkdirSync(runs)
  // 调度层那份文档**不读 `.dsh`**：`nightly-job-single`（②p）的缺省路径是真机器的 `schedule.json`，
  // 这里给它一个不在场的临时路径 ⇒ 这一条在本例里恒为 pending（种子没武装过），也不会因为本机
  // 后来真装出 nightly 而把「桥没断」这条 seam 断言变成红。
  return {
    memories,
    requests,
    runs,
    scheduleFile: path.join(work, 'schedule.json'),
    baseline: buildBaseline({ memoryDir: memories, requestsDir: requests, runsDir: runs }),
  }
}

async function judge(world: World, cardsExpected = 0): Promise<Map<string, Verdict>> {
  const verdicts = await computeVerdicts({
    memoryDir: world.memories,
    baseline: world.baseline,
    expect: JSON.parse(fs.readFileSync(path.join(world.memories, '.seed-expect.json'), 'utf8')) as {
      handEditedEntries?: readonly string[]
      expected?: { mustSurviveInIndex?: readonly string[], mustVanishFromIndex?: readonly string[] }
    },
    requestsDir: world.requests,
    runsDir: world.runs,
    scheduleFile: world.scheduleFile,
    cardsExpected,
  })
  return new Map(verdicts.map(verdict => [verdict.id, verdict]))
}

function statusOf(verdicts: Map<string, Verdict>, id: string): string {
  return verdicts.get(id)?.status ?? '缺失'
}

function touch(file: string): void {
  fs.appendFileSync(file, '\n人手补的一行说明，不该被蒸馏改写\n', 'utf8')
}

/**
 * 这份文件里的**绝对锚**：故意不复用生产端的 `sha256File`。②r 之后判据机与基线生产者共用同一个哈希函数，
 * 于是「两端同值」那类关系断言随两端一起漂；①b 与 ⑨ 都改用它，把「基准＝原始字节」与「哈希的是哪个文件」
 * 钉在一个第三方表达式上。
 */
function shaOfBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 写一份内核调度层文档的形状（单文档信封 + `tables.tasks`，字段按 `DailyScheduleRecord`），只用来喂一行
 * 夜间蒸馏任务。形状是本轮按真机器那份 `schedule.json` 的键名核过的（正文里不抄任何真值）。
 */
function writeScheduleRow(file: string, jobId: string): void {
  fs.writeFileSync(file, `${JSON.stringify({
    unit: { name: 'schedule', version: 1 },
    global: {},
    tables: {
      tasks: {
        [jobId]: {
          sessionId: 'sess-distiller-top',
          record: {
            id: jobId,
            kind: 'daily',
            title: DISTILL_TITLE,
            prompt: DISTILL_PROMPT,
            time: DISTILL_TIME,
            timeZone: DISTILL_TIME_ZONE,
            scheduledAt: '2026-11-02T03:30:00.000Z',
          },
          status: 'active',
          deliveryHistory: { records: [] },
        },
      },
    },
  }, null, 2)}\n`, 'utf8')
}

/**
 * 抛错在这里是**结果**而不是事故：水位线那几个变异体就是把 `try/catch` 摘掉（＝修复前的真实形态，
 * 启动器会在两个冷启动之后崩在 ENOENT 上），所以要让它落成一条具名 ✗，而不是整份自证半路死掉。
 */
function attempt<T>(fn: () => T): { ok: true, value: T } | { ok: false, error: string } {
  try {
    return { ok: true, value: fn() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// ① 哈希基准对齐：生产端 sha 的是**文件字节**，消费端比的是 `sha256(readFileSync(f,'utf8'))` 与
//    `sha256(store.readIndex())` —— 起手态必须两侧同值，否则 `index-rebuilt` 会在观测前就「绿」。
{
  const world = freshWorld()
  const verdicts = await judge(world)
  check('① 起手态：index-rebuilt 停在 pending（字节 sha == readIndex sha）',
    statusOf(verdicts, 'index-rebuilt') === 'pending', `实得 ${statusOf(verdicts, 'index-rebuilt')}`)
  check('① 起手态：hand-edited-untouched 绿（字节 sha == utf8 读回 sha）',
    statusOf(verdicts, 'hand-edited-untouched') === 'pass', `实得 ${statusOf(verdicts, 'hand-edited-untouched')}`)
  check('① 起手态：member-appended-daily 停 pending（dailyDays 口径同为无 .md 后缀）',
    statusOf(verdicts, 'member-appended-daily') === 'pending', `实得 ${statusOf(verdicts, 'member-appended-daily')}`)
  check('① 起手态：armed-marker 停 pending（生产端的 existsSync 口径对得上标记缺席的种子）',
    statusOf(verdicts, 'armed-marker') === 'pending', `实得 ${statusOf(verdicts, 'armed-marker')}`)
  check('① 起手态：一条 fail 都没有',
    [...verdicts.values()].every(verdict => verdict.status !== 'fail'),
    [...verdicts.values()].filter(v => v.status === 'fail').map(v => v.id).join(','))
  check('① 起手态：汇总退出码 = 3（待观测，不是通过也不是违反）',
    summarize([...verdicts.values()]).exitCode === 3, `实得 ${String(summarize([...verdicts.values()]).exitCode)}`)
}

// ①b 哈希基准的**绝对锚**：②r 之后消费端与生产端共用同一个 `sha256File`，于是上面那条「两端同值」的关系断言
//     自动成立 —— 生产端把基准改成 `trim()`／解码串时两端一起漂，接缝不再报红（本轮变异 d 就是这么活下来的：
//     共用读法消灭了漂移，也顺手消灭了那把偶然发现漂移的尺）。所以要拿一个**不共用那个函数**的表达式把基准钉死，
//     并要求语料本身能把它与另一种写法分开（②i：反向语料必须真能区分，否则这条锚是空的）。
{
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'step6-hash-'))
  works.push(work)
  const file = path.join(work, 'MEMORY.md')
  const bytes = Buffer.from('# 索引\r\n- 一行\n\n', 'utf8')
  fs.writeFileSync(file, bytes)
  check('①b 生产端的 sha 基准钉在原始字节（用不共用 sha256File 的表达式算）',
    sha256File(file) === shaOfBytes(bytes), `实得 ${sha256File(file).slice(0, 12)}…，应为 ${shaOfBytes(bytes).slice(0, 12)}…`)
  check('①b 语料确实能分开「trim 后算」与「原始字节」',
    shaOfBytes(Buffer.from(bytes.toString('utf8').trim(), 'utf8')) !== shaOfBytes(bytes),
    '这份语料 trim 前后同值 ⇒ 这条锚验的是一个不存在的差异，换语料重做')
  check('①b 文件读不到时返回空串而不是抛（让对应判定自己变红，而不是整台仪器崩在冷启动之后）',
    sha256File(path.join(work, 'not-there.md')) === '', `实得 ${sha256File(path.join(work, 'not-there.md'))}`)
}

// ② 真路径：基线经文件往返 —— 启动器写 step6-baseline.json，早上判据机 JSON.parse 读它。
{
  const world = freshWorld()
  const baselineFile = path.join(path.dirname(world.memories), 'seam-baseline.json')
  fs.writeFileSync(baselineFile, `${JSON.stringify(world.baseline, null, 2)}\n`, 'utf8')
  const ran = spawnSync(process.execPath, [
    '--import', 'tsx/esm', VERIFY, world.memories,
    '--baseline', baselineFile, '--requests-dir', world.requests, '--runs-dir', world.runs,
    '--schedule-file', world.scheduleFile,
  ], { cwd: KERNEL, encoding: 'utf8' })
  const out = `${ran.stdout ?? ''}${ran.stderr ?? ''}`
  check('② CLI 端到端：接受生产者的基线文件并以 3（待观测）退出',
    ran.status === 3, `实得 exit=${String(ran.status)}，输出尾行 ${out.split('\n').filter(line => line !== '').at(-1) ?? ''}`)
  check('② CLI 端到端：输出里没有一个 ×（把「还没发生」读成违反就是这条）',
    !out.split('\n').some(line => line.trimStart().startsWith('×')),
    out.split('\n').filter(line => line.trimStart().startsWith('×')).map(line => line.trim().slice(0, 60)).join(' / '))
}

// ③ ledgerRequestFiles 在场且可归属：别的实例删掉基线里的一条、夜间多出两张卡（成员臂 2 张）。
//    集合差 = 2 ⇒ 声明 2 张应为绿；字段丢了就退回计数差 = 1 ⇒ 判红。这一例让这个字段成为承重断言。
{
  const world = freshWorld()
  fs.writeFileSync(path.join(world.requests, 'a.json'), '{}', 'utf8')
  fs.writeFileSync(path.join(world.requests, 'b.json'), '{}', 'utf8')
  const withNames = buildBaseline({ memoryDir: world.memories, requestsDir: world.requests, runsDir: world.runs })
  check('③ 生产者把 requests 文件名清单写进基线',
    (withNames.ledgerRequestFiles ?? []).join(',') === 'a.json,b.json', (withNames.ledgerRequestFiles ?? []).join(','))
  fs.rmSync(path.join(world.requests, 'b.json'))
  fs.writeFileSync(path.join(world.requests, 'c.json'), '{}', 'utf8')
  fs.writeFileSync(path.join(world.requests, 'd.json'), '{}', 'utf8')
  const verdicts = await judge({ ...world, baseline: withNames }, 2)
  check('③ 集合差归属：夜间新增 2 张 == 声明 2 张 ⇒ ME8 判绿',
    statusOf(verdicts, 'zero-cards-from-distiller') === 'pass', `实得 ${statusOf(verdicts, 'zero-cards-from-distiller')}`)
  const declared = await judge({ ...world, baseline: withNames }, 0)
  const detail = declared.get('zero-cards-from-distiller')?.detail ?? ''
  check('③ 同现场声明 0 张 ⇒ 判红，且点名多出的是哪两条',
    statusOf(declared, 'zero-cards-from-distiller') === 'fail' && detail.includes('c.json') && detail.includes('d.json'), detail)
}

// ④ memoryRunFiles：基线里已经有的那行对账账目不能被当成夜间新增（否则「有对账行」是假绿）。
{
  const world = freshWorld()
  const envelope = { version: 1, record: { runId: 'pre-existing', outcome: 'distilled', promoted: 1, archived: 0, indexLines: 3, guardedSkips: 0, watermarkFrom: '2026-10-07', watermarkTo: '2026-10-10' } }
  fs.writeFileSync(path.join(world.runs, 'pre-existing.json'), JSON.stringify(envelope), 'utf8')
  const baseline = buildBaseline({ memoryDir: world.memories, requestsDir: world.requests, runsDir: world.runs })
  check('④ 生产者把 runs 文件名清单写进基线',
    (baseline.memoryRunFiles ?? []).join(',') === 'pre-existing.json', (baseline.memoryRunFiles ?? []).join(','))
  const verdicts = await judge({ ...world, baseline })
  check('④ 基线里那行账不算夜间新增 ⇒ run-rows 停 pending',
    statusOf(verdicts, 'run-rows') === 'pending', `实得 ${statusOf(verdicts, 'run-rows')}`)
}

// ⑤ 手改靶的解析口径：消费端按 .seed-expect.json 的 handEditedEntries[0] 认靶。换靶之后生产端必须
//    跟着换（这里同时把原靶正文改动一下当探针：仍写死旧路径的话基线 sha 就记成了改过的旧靶 ⇒ 判红）。
{
  const world = freshWorld()
  const expectFile = path.join(world.memories, '.seed-expect.json')
  const expect = JSON.parse(fs.readFileSync(expectFile, 'utf8'))
  expect.handEditedEntries = ['user/role.md']
  fs.writeFileSync(expectFile, `${JSON.stringify(expect, null, 2)}\n`, 'utf8')
  touch(path.join(world.memories, 'reference/hand-edited-guard.md'))
  check('⑤ 生产端从种子旁证解析靶（不是写死路径）',
    handEditedTarget(world.memories) === 'user/role.md', handEditedTarget(world.memories))
  const baseline = buildBaseline({ memoryDir: world.memories, requestsDir: world.requests, runsDir: world.runs })
  const verdicts = await judge({ ...world, baseline })
  check('⑤ 换靶后 hand-edited-untouched 仍绿（两边指同一个文件）',
    statusOf(verdicts, 'hand-edited-untouched') === 'pass',
    `实得 ${statusOf(verdicts, 'hand-edited-untouched')}：${verdicts.get('hand-edited-untouched')?.detail ?? ''}`)
}

// ⑥ 水位线：缺文件或形状不对都要产 null 而不是抛（启动器要是崩在冷启动之后，一整夜就白等了）。
{
  const world = freshWorld()
  fs.rmSync(path.join(world.memories, 'daily/.watermark'))
  const missing = attempt(() => readWatermark(world.memories))
  check('⑥ 水位线文件缺失 ⇒ readWatermark 返回 null 且不抛', missing.ok && missing.value === null,
    missing.ok ? `实得 ${JSON.stringify(missing.value)}` : `抛了：${missing.error}`)
  fs.writeFileSync(path.join(world.memories, 'daily/.watermark'), '{"lastDay":"2026-10-07"}\n', 'utf8')
  const shaped = attempt(() => readWatermark(world.memories))
  check('⑥ 水位线形状不对（缺 lastDistilledAt）⇒ 同样返回 null', shaped.ok && shaped.value === null,
    shaped.ok ? `实得 ${JSON.stringify(shaped.value)}` : `抛了：${shaped.error}`)
  const built = attempt(() => buildBaseline({ memoryDir: world.memories, requestsDir: world.requests, runsDir: world.runs }))
  const verdicts = built.ok ? await judge({ ...world, baseline: built.value }) : new Map<string, Verdict>()
  check('⑥ 基线里 watermark=null ⇒ 判定停 pending，不报倒退',
    built.ok && built.value.watermark === null && statusOf(verdicts, 'watermark-advanced') === 'pending',
    built.ok ? `watermark=${JSON.stringify(built.value.watermark)} 判定=${statusOf(verdicts, 'watermark-advanced')}` : `生产者抛了：${built.error}`)
}

// ⑦ 正文不外泄：那两个台账目录真观测时在 .dsh 下，装的是别人的 argsSnapshot；基线只许记名字。
{
  const world = freshWorld()
  const probe = 'SEAM-PROBE-DO-NOT-COPY'
  fs.writeFileSync(path.join(world.requests, 'card.json'), JSON.stringify({ version: 1, record: { argsSnapshot: { ops_password: probe } } }), 'utf8')
  fs.writeFileSync(path.join(world.runs, 'run.json'), JSON.stringify({ version: 1, record: { runId: probe, justification: probe } }), 'utf8')
  const serialized = JSON.stringify(buildBaseline({ memoryDir: world.memories, requestsDir: world.requests, runsDir: world.runs }))
  // 失败时也只报「含哪一种不该含的东西 + 基线键名」，绝不把序列化内容片段打进日志（这个字面本身就是要外泄的东西的样例）。
  const leakedKeys = Object.keys(JSON.parse(serialized)).filter(key => key.endsWith('Bodies'))
  check('⑦ 基线序列化后不含台账正文（探针字面与 argsSnapshot 都没被抄进来）',
    !serialized.includes(probe) && !serialized.includes('argsSnapshot'),
    `多出键：${leakedKeys.join(',') || '无'}；含探针字面=${String(serialized.includes(probe))}`)
}

// ⑧ 调度层那条入参在本文件里真被传到位：`readSchedule` 读不到文件会被 `try/catch` 静默吞成「不在场」，
//    于是漏传 `scheduleFile` 不报错、只让那一枪永远 pending。这里给一份「有夜间行而标记不在场」的文档 ——
//    漏传就得到 pending，传到位才得到带 jobIds 的红。
{
  const world = freshWorld()
  writeScheduleRow(world.scheduleFile, 'job-seam-1')
  const verdicts = await judge(world)
  const detail = verdicts.get('nightly-job-single')?.detail ?? ''
  check('⑧ seam 把 scheduleFile 递进判定层：调度层有残留行而标记不在场 ⇒ 判红并点名该行',
    statusOf(verdicts, 'nightly-job-single') === 'fail' && detail.includes('job-seam-1'),
    `实得 ${statusOf(verdicts, 'nightly-job-single')}：${detail.slice(0, 160)}`)
}

// ⑧b 同上，但走 CLI 那一臂：`--schedule-file` 若没被接住，进程会退回缺省路径去读真机器那份文档
//     （本机此刻没有 nightly 行 ⇒ 该枪变 pending、退出码变 3）。这一例把「不读 .dsh」变成断言而不是声明。
{
  const world = freshWorld()
  const baselineFile = path.join(path.dirname(world.memories), 'seam-schedule-cli.json')
  fs.writeFileSync(baselineFile, `${JSON.stringify(world.baseline, null, 2)}\n`, 'utf8')
  writeScheduleRow(world.scheduleFile, 'job-seam-cli')
  const ran = spawnSync(process.execPath, [
    '--import', 'tsx/esm', VERIFY, world.memories,
    '--baseline', baselineFile, '--requests-dir', world.requests, '--runs-dir', world.runs,
    '--schedule-file', world.scheduleFile,
  ], { cwd: KERNEL, encoding: 'utf8' })
  const out = `${ran.stdout ?? ''}${ran.stderr ?? ''}`
  const red = out.split('\n').find(line => line.trimStart().startsWith('×')) ?? ''
  check('⑧b CLI 接受 --schedule-file：该文档里的残留 nightly 行被判红、点名给它、退出码 1',
    ran.status === 1 && red.includes('nightly-job-single') && red.includes('job-seam-cli'),
    `实得 exit=${String(ran.status)}，红行=${red.trim().slice(0, 160) || '(无)'}`)
}

// ⑨ **文件名归产品所有，生产端只能按行为对账**：`daily/.watermark`／`daily/.distill-armed`／`MEMORY.md`／`daily/`
//     这四个名字在 `store.ts` 里是私有常量（`WATERMARK_PATH`／`ARMED_PATH`）或内联字面，而 `.mjs` 生产者
//     **import 不到 `.ts`** —— 于是「产品哪天改了名」这件事在两端各自都不报错：生产端读到 `null`／`false`／空串，
//     判据机又把「读不到」当成「还没发生」⇒ 那一夜的水位线、武装、索引三枪全部静默停在 pending，早上那张表一片绿。
//     这一例反过来走：用**真 store** 写下这四样，再要求生产端与产品自己那把尺同时读到同一件事，两边任一改名都当场红。
{
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'step6-names-'))
  works.push(work)
  const memories = path.join(work, 'memories')
  const requests = path.join(work, 'requests')
  const runs = path.join(work, 'runs')
  fs.mkdirSync(memories)
  fs.mkdirSync(requests)
  fs.mkdirSync(runs)
  const DAY = new Date(2026, 9, 10, 12).getTime()
  const store = new MemoryStore(memories, { now: () => DAY })
  const read = (): Baseline => buildBaseline({ memoryDir: memories, requestsDir: requests, runsDir: runs })

  const before = read()
  const armedBefore = await store.readArmedJob()
  check('⑨ 空目录：生产端报「没武装、没水位线、没索引」而不抛（armedMarkerAtStart=false ↔ store 也读不到 jobId）',
    before.armedMarkerAtStart === false && armedBefore === undefined
      && readWatermark(memories) === null && before.memoryMdSha256 === '',
    `armed=${String(before.armedMarkerAtStart)}/${String(armedBefore)}，watermark=${JSON.stringify(readWatermark(memories))}，indexSha=«${before.memoryMdSha256}»`)

  const watermark = { at: 1_760_000_000_000, lastDay: '2026-10-07' }
  await store.writeWatermark(watermark.at, watermark.lastDay)
  const producerWatermark = readWatermark(memories)
  const storeWatermark = await store.readWatermark()
  check('⑨ store.writeWatermark 落的那份，生产端按同一路径＋同一形状读得回来（改名＝把水位线读成 null，DM8 失去依据）',
    producerWatermark !== null && producerWatermark.lastDistilledAt === watermark.at && producerWatermark.lastDay === watermark.lastDay
      && storeWatermark !== undefined && storeWatermark.lastDistilledAt === producerWatermark.lastDistilledAt
      && storeWatermark.lastDay === producerWatermark.lastDay,
    `生产端=${JSON.stringify(producerWatermark)}，store=${JSON.stringify(storeWatermark)}`)

  const indexText = `${INDEX_HEADER}\n- [一条](user/one.md) — 钩子\n`
  await store.writeArmedJob('job-from-store')
  await store.writeIndex(indexText)
  const dailyFile = await store.appendDaily('成员追加的一行流水')
  const after = read()
  const armedAfter = await store.readArmedJob()
  check('⑨ store.writeArmedJob 落的标记被生产端的 existsSync 看到（改名＝「起手态已有标记」那一支永不触发，凭空多出一夜武装）',
    after.armedMarkerAtStart === true && armedAfter === 'job-from-store',
    `armed=${String(after.armedMarkerAtStart)}/${String(armedAfter)}`)
  check('⑨ 生产端哈希的正是 store.writeIndex 落的那个文件（字节基准，用 ①b 那把不共用的尺算）',
    after.memoryMdSha256 === shaOfBytes(Buffer.from(indexText, 'utf8')),
    `实得 «${after.memoryMdSha256.slice(0, 12)}…»，应为 «${shaOfBytes(Buffer.from(indexText, 'utf8')).slice(0, 12)}…»`)
  check('⑨ store.appendDaily 落的那天在生产端的日级清单里（daily 目录名与 YYYY-MM-DD 文件名两端同形）',
    dailyFile === 'daily/2026-10-10.md' && after.dailyDays.join(',') === '2026-10-10',
    `store 返回 ${dailyFile}，生产端清单=${after.dailyDays.join(',') || '(空)'}`)
}

works.forEach(work => fs.rmSync(work, { recursive: true, force: true }))
if (failures > 0) {
  console.log(`\nFAIL：${String(failures)} 项契约不符 ⇒ 第 6 步那夜的基线不可信`)
  process.exit(1)
}
console.log(`\nPASS 第 6 步基线契约（${String(passes)} ✓ / ${String(failures)} ✗：生产者 → 文件 → 判据机这条接缝，加生产端哈希基准的绝对锚 ①b 与那四个文件名的反向对账 ⑨；真临时目录，未起产品进程、未读 .dsh）`)
