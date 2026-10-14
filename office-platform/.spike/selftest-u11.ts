/**
 * `u11-report.ts` 的自检：用**真代码**（真 `ApprovalLedger` + 真 storage-json 落盘 + 真 storage-domain 读回）
 * 验一把还没被人用过的尺。
 *
 * 为什么这一步不能省：U11 的三选一完全建立在这把尺的读数上。尺子偏了不会有人当场发现 ——
 * 它不像审批闸那样会「放行一次坏动作」，它只会让一个本来该改的档位看起来不用改。所以每一条正向
 * 都配一条反向：反向是「换个写法就会是对的结果」的那些写法，它们必须红。
 *
 * 反过来说，这里**不**起产品进程、**不**产生模型回合：统计件的声明是「数得对、丢行会报、正文不外泄」，
 * 这三条都能在临时盘上答完；「验收周读数到底是多少」不是它能证明的，那是 #43 之后真人跑一周的事。
 *
 * 跑法（`--import tsx/esm` 需要内核那份 tsx，所以在内核根执行）：
 *   cd ../deepseek-harness && node --import tsx/esm "../office-platform/.spike/selftest-u11.ts"
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { ApprovalLedger, approvalLedgerDomain, type ApprovalRequestRecord } from '../plugins/office-approval/ledger.ts'
import {
  defaultSearchTools,
  findDroppedRequests,
  parseCli,
  parseTime,
  readAllRequests,
  renderSummary,
  reportRun,
  requestFileNames,
  requestsDir,
  runCli,
  summarizeAsks,
} from './u11-report.ts'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${label}`)
    return
  }
  failures += 1
  console.log(`  ✗ ${label}${detail === '' ? '' : ` —— ${detail}`}`)
}

/** 正文里种一根唯一针：任何一处把 `actionSummary` / `displayReason` / `toolArgs` 漏进输出，这根针就会出现。 */
const NEEDLE = 'NEEDLE-3f9c1b-不该出现在任何输出里'
/** 两条询问只差 `justification` 时用的同一份「真参数」—— U9 卡片会说「第 2 次」的那一组。 */
const SAME_ARGS = { file_path: 'C:/tmp/same.txt', query: 'same query' }

interface Spec {
  readonly id: string
  readonly session: string
  readonly tool: string
  readonly risk: ApprovalRequestRecord['riskLevel']
  readonly status: ApprovalRequestRecord['status']
  readonly day: string
  readonly decidedAt?: number | null
  readonly windowEndsAt?: number
  readonly args?: Record<string, unknown>
}

function toRecord(spec: Spec): ApprovalRequestRecord {
  const askedAt = Date.parse(`${spec.day}T05:00:00.000Z`)
  return {
    requestId: spec.id,
    sessionId: spec.session,
    tenantId: 'tenant-local',
    toolName: spec.tool,
    riskLevel: spec.risk,
    actionSummary: `动作摘要 ${NEEDLE}`,
    toolArgs: spec.args ?? { file_path: `C:/tmp/${spec.id}.txt`, justification: '一次性理由' },
    displayReason: `展示原因 ${NEEDLE}`,
    status: spec.status,
    askedAt,
    windowEndsAt: spec.windowEndsAt ?? askedAt + 90_000,
    expiresAt: askedAt + 3_600_000,
    decidedBy: spec.decidedAt === undefined || spec.decidedAt === null ? null : 'ou_approver',
    decidedAt: spec.decidedAt ?? null,
  }
}

/**
 * 造一条「磁盘上有、但形状读不懂」的记录：走 JSON 往返，所以拿到的是磁盘上真会出现的形状
 * （数字变字符串、字段变 `null`），而不是靠双重断言在类型系统里撒的谎。
 */
function corrupt(value: Record<string, unknown>): ApprovalRequestRecord {
  return JSON.parse(JSON.stringify(value)) as ApprovalRequestRecord
}

const SINCE = Date.parse('2026-10-11T00:00:00.000Z')
const UNTIL = Date.parse('2026-10-13T00:00:00.000Z')

/** 七条：六条落窗口、一条落窗口外；其中三条是检索类、一条名字里含着检索名但不是、一对只差 `justification`、一对跨会话。 */
const CORPUS: readonly Spec[] = [
  { id: 'r1', session: 's1', tool: 'web_search', risk: 'L3', status: 'pending', day: '2026-10-11', args: { ...SAME_ARGS, justification: '第一版理由' } },
  { id: 'r2', session: 's1', tool: 'web_search', risk: 'L3', status: 'pending', day: '2026-10-11', args: { ...SAME_ARGS, justification: '第二版理由' } },
  { id: 'r3', session: 's1', tool: 'web_fetch', risk: 'L2', status: 'approved', day: '2026-10-11', decidedAt: Date.parse('2026-10-11T05:00:01.000Z') },
  { id: 'r4', session: 's1', tool: 'write_file', risk: 'L3', status: 'rejected', day: '2026-10-11', decidedAt: Date.parse('2026-10-11T06:00:00.000Z') },
  { id: 'r5', session: 's2', tool: 'web_search', risk: 'L4', status: 'consumed', day: '2026-10-12', args: { ...SAME_ARGS, justification: '别的会话' }, decidedAt: Date.parse('2026-10-12T05:02:00.000Z') },
  { id: 'r6', session: 's2', tool: 'internal_web_search', risk: 'L3', status: 'pending', day: '2026-10-12' },
  { id: 'r7', session: 's2', tool: 'read_file', risk: 'L1', status: 'expired', day: '2026-10-13' },
]

async function main(): Promise<void> {
  const records = CORPUS.map(toRecord)
  const summary = summarizeAsks(records, { since: SINCE, until: UNTIL })

  console.log('正向 · 全量聚合')
  check('窗口内计入 6 条、窗口外 1 条（r7 不在分母里）', summary.counted === 6 && summary.outOfRange === 1,
    `counted=${summary.counted} outOfRange=${summary.outOfRange}`)
  check('检索类 4 条 ⇒ 占比 4/6', summary.searchCount === 4 && Math.abs(summary.searchShare - 4 / 6) < 1e-12,
    `searchCount=${summary.searchCount} share=${summary.searchShare}`)
  check('按天拆开：10-11 = 4 条里 3 条检索，10-12 = 2 条里 1 条检索',
    summary.perDay.length === 2
      && summary.perDay[0]!.day === '2026-10-11' && summary.perDay[0]!.total === 4 && summary.perDay[0]!.search === 3
      && summary.perDay[1]!.day === '2026-10-12' && summary.perDay[1]!.total === 2 && summary.perDay[1]!.search === 1,
    JSON.stringify(summary.perDay))
  check('会话数 2', summary.sessions === 2, `sessions=${summary.sessions}`)
  check('等级/状态按字段计数（L3=4、L2=1、L4=1；pending=3、approved=1、rejected=1、consumed=1）',
    summary.byRisk['L3'] === 4 && summary.byRisk['L2'] === 1 && summary.byRisk['L4'] === 1
    && summary.byStatus['pending'] === 3 && summary.byStatus['approved'] === 1
    && summary.byStatus['rejected'] === 1 && summary.byStatus['consumed'] === 1
    && !('expired' in summary.byStatus),
    JSON.stringify({ risk: summary.byRisk, status: summary.byStatus }))
  check('工具表按计数降序、同数按名字升序（web_search 3 → internal_web_search/web_fetch/write_file 各 1）',
    summary.byTool.map(row => `${row.toolName}:${row.count}`).join(' ') === 'web_search:3 internal_web_search:1 web_fetch:1 write_file:1',
    summary.byTool.map(row => `${row.toolName}:${row.count}`).join(' '))
  check('裁决分桶按 `decidedAt` 与 `windowEndsAt` 判：窗口内 1、超窗才裁决 2、还在等 3（三桶相加＝分母）',
    summary.decidedInWindow === 1 && summary.decidedAfterWindow === 2 && summary.awaitingDecision === 3
    && summary.decidedInWindow + summary.decidedAfterWindow + summary.awaitingDecision === summary.counted,
    JSON.stringify([summary.decidedInWindow, summary.decidedAfterWindow, summary.awaitingDecision]))
  check('重复询问：只差 `justification` 的两次算同一组（这就是卡片会说「第 2 次」的那一次）',
    summary.repeatGroups.length === 1
      && summary.repeatGroups[0]!.sessionId === 's1' && summary.repeatGroups[0]!.toolName === 'web_search'
      && summary.repeatGroups[0]!.count === 2 && summary.maxRepeat === 2,
    JSON.stringify(summary.repeatGroups))

  console.log('反向 · 换个写法就会是对的结果，那些写法必须红')
  check('跨会话不并组：`r5` 与 `r1/r2` 参数一字不差，但属于另一个会话 ⇒ 组里只有 s1',
    summary.repeatGroups.every(group => group.sessionId === 's1') && summary.maxRepeat === 2,
    JSON.stringify(summary.repeatGroups))
  const single = summarizeAsks(records.filter(r => r.requestId !== 'r2'), { since: SINCE, until: UNTIL })
  check('少了第二次询问 ⇒ 无重复组（若 digest 恒等或按 toolName 归组，这里仍会报出「重复」）',
    single.repeatGroups.length === 0 && single.maxRepeat === 0, JSON.stringify(single.repeatGroups))
  check('分子只认全名：`internal_web_search` 不是检索类（按子串匹配会是 5/6，占比虚高）',
    summary.searchCount === 4 && summary.byTool.some(row => row.toolName === 'internal_web_search'),
    `searchCount=${summary.searchCount}`)
  const renamed = summarizeAsks(records, { since: SINCE, until: UNTIL, searchTools: ['web_search', 'web_fetch', 'internal_web_search'] })
  check('把 `internal_web_search` 显式写进名单 ⇒ 占比确实跳到 5/6（证明上一条在测的是名单，不是碰巧）',
    renamed.searchCount === 5 && Math.abs(renamed.searchShare - 5 / 6) < 1e-12, `share=${renamed.searchShare}`)
  const empty = summarizeAsks([], { since: SINCE, until: UNTIL })
  check('空账本 ⇒ counted 0、占比 0（不是 NaN）、`maxRepeat` 0',
    empty.counted === 0 && empty.searchShare === 0 && !Number.isNaN(empty.searchShare) && empty.maxRepeat === 0,
    `share=${empty.searchShare}`)
  check('窗口外的记录进 `outOfRange`、不静默丢：分母 6 + 窗口外 1 = 语料 7',
    summary.outOfRange === 1 && summary.counted + summary.outOfRange === CORPUS.length)
  const noLower = summarizeAsks(records, { until: UNTIL })
  check('不给 `since` ⇒ 下界是「不限」：读数与给定 10-11 完全一致（默认值不会偷偷缩窗）',
    noLower.counted === summary.counted && noLower.outOfRange === summary.outOfRange && noLower.searchCount === summary.searchCount)
  const broken = summarizeAsks(records.concat([
    corrupt({ ...toRecord(CORPUS[0]!), requestId: 'bad1', askedAt: 'not-a-number' }),
    corrupt({ ...toRecord(CORPUS[0]!), requestId: 'bad2', toolName: null }),
  ]), { since: SINCE, until: UNTIL })
  check('读不懂的行 ⇒ 点名两条且分母不变（不拿半条记录凑数，也不静默跳过）',
    broken.anomalous.join(',') === 'bad1,bad2' && broken.counted === 6,
    JSON.stringify({ anomalous: broken.anomalous, counted: broken.counted }))
  check('检索类名单就是那两个名字（多一个少一个都改变 U11 的读数，所以这里钉死）',
    defaultSearchTools.join(',') === 'web_search,web_fetch')


  console.log('真盘 · 经真 `ApprovalLedger` 落盘、再经真 storage-domain 读回')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'u11-selftest-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const ledger = new ApprovalLedger(await ctx.storageDomain.open(approvalLedgerDomain))
  for (const record of records) await ledger.create(record)
  const files = requestFileNames(root)
  const readBack = await readAllRequests(root)
  check('落盘目录就是台账自己那扇门背后的目录', fs.existsSync(requestsDir(root)) && files.length === CORPUS.length,
    `files=${files.length} dir=${requestsDir(root)}`)
  check('读回的条数与主键集合 = 写进去的（信封 `{version,record}` 由域剥，不自己拼磁盘形状）',
    readBack.length === CORPUS.length
      && readBack.map(r => r.requestId).sort().join(',') === records.map(r => r.requestId).sort().join(','),
    `readBack=${readBack.length}`)
  const readSummary = summarizeAsks(readBack, { since: SINCE, until: UNTIL })
  check('读回再聚合的每个数都与内存聚合一致（磁盘往返不改变读数）',
    JSON.stringify(readSummary) === JSON.stringify(summary),
    `${JSON.stringify(readSummary)}\n    ${JSON.stringify(summary)}`)
  check('无丢行 ⇒ `findDroppedRequests` 空', findDroppedRequests(files, readBack).length === 0)
  fs.writeFileSync(path.join(requestsDir(root), 'ghost-row.json'), '{}', 'utf8')
  check('手写一条域读不回来的文件 ⇒ 点名它（这就是「分母少了」的证据）',
    findDroppedRequests(requestFileNames(root), readBack).join(',') === 'ghost-row')
  fs.rmSync(path.join(requestsDir(root), 'ghost-row.json'))

  const exitCode = await reportRun({ storageRoot: root, since: SINCE, until: UNTIL })
  check('真盘 `reportRun()` ⇒ 窗口内有数据 ⇒ 退出码 0，报告里是那六个数',
    exitCode.code === 0 && exitCode.report.includes('计入 6 条') && exitCode.report.includes('占比 66.7%'),
    `code=${exitCode.code}`)
  const emptyWindow = await reportRun({ storageRoot: root, since: Date.parse('2027-01-01T00:00:00.000Z') })
  check('窗口里一条都没有 ⇒ 退出码 1 且报告自己说清「窗口外 7 条」（0 条绝不等于「没人被卡过」）',
    emptyWindow.code === 1 && emptyWindow.report.includes('窗口内 0 条') && emptyWindow.report.includes('窗口外 7 条'),
    `code=${emptyWindow.code}`)
  const missing = await reportRun({ storageRoot: path.join(root, 'nope') })
  check('台账目录不存在 ⇒ 退出码 1 + 点名那个目录（区分「没这本账」与「账是空的」）',
    missing.code === 1 && missing.report.includes('台账目录不存在') && missing.report.includes(path.join('nope', 'office_approval_ledger')),
    `code=${missing.code}`)
  fs.writeFileSync(path.join(requestsDir(root), 'ghost-row.json'), '{}', 'utf8')
  const ghost = await reportRun({ storageRoot: root, since: SINCE, until: UNTIL })
  check('有行没被读回来 ⇒ 退出码 1 且点名 `ghost-row`（这条守住的是「分母少了就是假绿」）',
    ghost.code === 1 && ghost.report.includes('ghost-row'), `code=${ghost.code}`)
  fs.rmSync(path.join(requestsDir(root), 'ghost-row.json'))

  console.log('正文零泄漏 · 三种输出形态各验一次')
  const rendered = renderSummary(summary, { since: SINCE, until: UNTIL })
  check('人读报告不含 `actionSummary` / `displayReason` / `toolArgs` 正文（种针）', !rendered.includes(NEEDLE))
  const out = path.join(root, 'report.txt')
  const wrote = await runCli({ storageRoot: root, since: SINCE, until: UNTIL, out })
  const onDisk = fs.readFileSync(out, 'utf8')
  check('写进 `--out` 的那份同样不含正文针，且退出码从同一扇门出来', wrote === 0 && onDisk.includes('U11 量尺') && !onDisk.includes(NEEDLE))
  const jsonOut = path.join(root, 'report.json')
  await runCli({ storageRoot: root, since: SINCE, until: UNTIL, json: true, out: jsonOut })
  const jsonText = fs.readFileSync(jsonOut, 'utf8')
  check('`--json` 那份也不含正文（JSON 里没有 `toolArgs` 字段可漏）',
    !jsonText.includes(NEEDLE) && !jsonText.includes('displayReason') && !('toolArgs' in JSON.parse(jsonText)))


  console.log('用法面 · CLI')
  const noRoot = parseCli([])
  const jsonOnly = parseCli(['--json'])
  check('缺 `--storage-root` ⇒ 用法错，并且说的是这一句（绝不默认到 `~/.dsh` 那棵带凭据的树）',
    noRoot.ok === false && noRoot.message.includes('--storage-root')
      && jsonOnly.ok === false && jsonOnly.message.includes('--storage-root'),
    JSON.stringify(noRoot.ok ? noRoot.options : noRoot.message) + ' / ' + JSON.stringify(jsonOnly.ok ? jsonOnly.options : jsonOnly.message))
  const parsed = parseCli(['--storage-root', root, '--since', '2026-10-11', '--until', '2026-10-13', '--search-tools', 'web_search, web_fetch', '--json'])
  check('开关解析：`--json` 不吃下一个值、日期按 UTC 零点、逗号名单去空格',
    parsed.ok === true && parsed.options.storageRoot === root && parsed.options.json === true
      && parsed.options.since === SINCE && parsed.options.until === UNTIL
      && parsed.options.searchTools?.join(',') === 'web_search,web_fetch',
    JSON.stringify(parsed.ok ? parsed.options : parsed.message))
  check('未知开关 ⇒ 用法错（不静默忽略一个打错的参数）', parseCli(['--storage-root', root, '--seach']).ok === false)
  check('空检索名单 ⇒ 用法错（空名单会把占比报成 0%，看起来像「检索卡一条没有」）',
    parseCli(['--storage-root', root, '--search-tools', ' , ']).ok === false)

  check('`parseTime`：日期与毫秒都收，别的拒（收到 `undefined` 由调用方报 2）',
    parseTime('2026-10-11') === SINCE && parseTime('1792000000000') === 1792000000000
      && parseTime('昨天') === undefined && parseTime('2026-13-99') === undefined)

  await ctx.fiber.dispose()
  fs.rmSync(root, { recursive: true, force: true })
}

main().then(() => {
  console.log(failures === 0 ? `\n全绿：${'U11 量尺的每条正向都有对应的反向在守着'}` : `\n失败 ${failures} 条`)
  process.exitCode = failures === 0 ? 0 : 1
}).catch(error => {
  console.error('自检本身跑坏了：', error)
  process.exitCode = 1
})



