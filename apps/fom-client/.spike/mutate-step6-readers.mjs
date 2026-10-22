/**
 * 判据机 `.spike/verify-step6.ts` 里「②r 差值两端同源」那一组的变异检验：把每一处**共用读法**逐个改回
 * 「判据自己另写一套读法」，看 `.spike/selftest-verify-step6.ts` 是否出具名红例（`×` 行）。
 *
 * 为什么这一组要有自己的变异：差值判据的两端（晚上落的基线 / 早上读的当前盘）此前是两套代码 ——
 * 哈希一个按字节一个按解码串、日级清单一个按名字一个要求普通文件、手改靶一个来自旁证一个写死。
 * 三种坏形状都**不会报错**，只会让早上那张表把「蒸馏没跑」读成「跑过了」或把整张表崩成一坨栈。
 * 所以每条共用都要有一枪对着：改回各写各的时，必须有红例立刻出现。
 *
 * 变异只打在 `.spike` 仪器上，**产品码一字节不动**。
 *
 * 纪律照 `mutate-probe-schedule.mjs`：一次只跑一份 harness、日志等进程退出后再读、变异期间不起产品。
 * 每个变异独立应用到原件、跑完立刻还原并按字节校验，任何一刻磁盘上只有一份变异。
 *
 * 判红口径：先去 ANSI，再只按「这行有没有 `×`」判（⚠️ 这份自证打的是 `×` 不是 `✗`，两台仪器的标记字符不一样，
 * 抄错会把整轮变异全读成「崩了」）；只有退出码非 0 而没有具名红例的，单独标出来（那是崩了，不是抓住）。
 *
 * 跑法：node "F:/deepseek/deepseek harness/apps/fom-client/.spike/mutate-step6-readers.mjs"
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = 'F:/deepseek/deepseek harness/apps/fom-client'
const KERNEL = 'F:/deepseek/deepseek harness/deepseek-harness'
const TARGET = join(ROOT, '.spike/verify-step6.ts')
const SELFTEST = join(ROOT, '.spike/selftest-verify-step6.ts')
const SEED = join(ROOT, '.spike/distill-workspace')

/**
 * 判红标记字符**从自证件的源码里读回来**，不写死：这台机器上两台仪器一个打 `×`、一个打 `✗`，
 * 抄错时每个变异都只报「崩了」（本轮真踩过一次，报出 0/8 的假象）。两种都有或都没有都算失败。
 */
const selftestSource = readFileSync(SELFTEST, 'utf8')
const marks = ['×', '✗'].filter(mark => selftestSource.includes(`${mark} `))
if (marks.length !== 1) throw new Error(`判红标记字符判定失败：命中 ${String(marks.length)} 种（仪器改了标记字符，或这份 harness 的候选集要补）`)
const RED_LINE = new RegExp(`^${marks[0]} (.+)$`, 'gm')

const MUTANTS = [
  {
    id: 'a-vanished-days-not-computed',
    claim: '「基线有而现在没有」不再计算（恒报只增不减成立）—— ⑮ 必须红：DM8 的幂等前提是水已推过的日级还在，那天被重种冲掉后判据仍绿，内容永久失踪也没人知道',
    from: '  const vanishedDays = baseline.dailyDays.filter(day => !state.dailyDays.includes(day))',
    to: '  const vanishedDays: string[] = []',
  },
  {
    id: 'b-producer-side-list-ignored',
    claim: '对账只看「产品 store 多出来的」，不看「只有基线读法看到的」—— ⑯ 必须红：目录／链接形状的日子会被基线算成一天、被蒸馏当成没写过，成员那一枪的观测面与执行面就此分家',
    from: '  const onlyProducer = state.dailyDays.filter(day => !state.dailyDaysSeenByStore.includes(day))',
    to: '  const onlyProducer: string[] = []',
  },
  {
    id: 'c-index-hash-from-wrong-file',
    claim: '当前盘的索引哈希换成另一个文件（`daily/.watermark`）—— ①②③⑰ 那一族必须红：差值的一端根本不是 `MEMORY.md`，「sha 变了」与蒸馏没关系，整条 ME10 判据变成随机数',
    from: "    indexSha256: sha256File(path.join(input.memoryDir, 'MEMORY.md')),",
    to: "    indexSha256: sha256File(path.join(input.memoryDir, 'daily/.watermark')),",
  },
  {
    id: 'd-target-drift-guard-removed',
    claim: '拆掉「晚上记的靶 ≠ 早上解析的靶」那条守卫 —— ⑱ 必须红：旁证在两时点之间被改过时，这条判定比的两个 sha 分属两个文件，无论红绿都不说明蒸馏动了什么，却照样出一个绿',
    from: '  const handTargetDrift = baseline.handEditedTarget !== undefined && baseline.handEditedTarget !== state.handEditedTarget',
    to: '  const handTargetDrift = false',
  },
  {
    id: 'e-target-hardcoded-again',
    claim: '判据改回自己写死手改靶路径（不用生产端的解析器）—— ⑱ 必须红：这正是 ②k 抓过的那个原缺陷的镜像面，换靶之后「一字节没动」比的根本不是同一个文件 ⇒ V2 假绿',
    from: '  const handEditedTarget = resolveHandEditedTarget(input.memoryDir)',
    to: "  const handEditedTarget = 'reference/hand-edited-guard.md'",
  },
  {
    id: 'f-both-readers-fed-the-same-list',
    claim: '产品 store 那份日级清单换成生产者的那份（两边不再各自读一次）—— ⑯ 必须红：对账自己跟自己对账，永远成立，「两种读法看到不同清单」这件事从此不可能被观测到',
    from: '    dailyDaysSeenByStore: daysSeenByStore,',
    to: '    dailyDaysSeenByStore: days,',
  },
  {
    id: 'g-vanished-day-not-named',
    claim: '红例不再点名少了哪一天 —— ⑮b 必须红：只报「少了若干天」时观测当天不知道该去核 `daily/` 里的哪个文件，动作会做错（去重种 vs 找蒸馏）',
    from: "少了 ${vanishedDays.join(',')} —— 去核",
    to: '少了若干天 —— 去核',
  },
  {
    id: 'h-parity-detail-not-named',
    claim: '对账红例不报两边各自看到的名单 —— ⑯b 必须红：不说是哪一边看到的，就没法判断是残留目录还是产品漏读，去核的动作同样做错',
    from: "只有基线读法看到：${onlyProducer.join(',') || '(无)'}；只有产品 store 看到：${onlyStore.join(',') || '(无)'}",
    to: '两边读到的日级清单不一致',
  },
]

function runSelftest() {
  let exit = 0
  let out = ''
  try {
    out = execFileSync(process.execPath, ['--import', 'tsx/esm', SELFTEST, SEED], {
      cwd: KERNEL, encoding: 'utf8', stdio: 'pipe', timeout: 600_000,
    })
  } catch (error) {
    exit = typeof error.status === 'number' ? error.status : -1
    out = `${String(error.stdout ?? '')}${String(error.stderr ?? '')}`
  }
  const plain = out.replace(/\u001B\[[0-9;]*m/g, '')
  const failed = [...new Set([...plain.matchAll(RED_LINE)].map(match => match[1].trim()))]
  return { exit, failed, green: plain.includes('PASS verify-step6 判定自证') }
}

const LOG = join(ROOT, '.spike/mutate-step6-readers.log')
const lines = []
const flush = line => {
  lines.push(line)
  appendFileSync(LOG, `${line}\n`, 'utf8')
  console.log(line)
}

writeFileSync(LOG, '', 'utf8')
const baseline = runSelftest()
flush(`baseline: ${baseline.exit === 0 && baseline.green ? `green（${String(baseline.failed.length)} 红）` : `RED (exit=${String(baseline.exit)} 红例=${String(baseline.failed.length)}) —— 变异前就红，本轮结论不可信`}`)
if (!(baseline.exit === 0 && baseline.green)) {
  for (const name of baseline.failed.slice(0, 10)) appendFileSync(LOG, `    · ${name}\n`, 'utf8')
  process.exit(1)
}

for (const mutant of MUTANTS) {
  const original = await readFile(TARGET, 'utf8')
  if (!original.includes(mutant.from)) {
    flush(`${mutant.id}: SKIPPED（锚点没找到，变异没应用）`)
    continue
  }
  await writeFile(TARGET, original.replace(mutant.from, mutant.to), 'utf8')
  const result = runSelftest()
  await writeFile(TARGET, original, 'utf8')
  if (await readFile(TARGET, 'utf8') !== original) throw new Error(`${mutant.id}: 还原失败`)
  const kind = result.failed.length > 0 ? '抓住（断言式）' : result.exit === 0 ? '活下来' : '崩了（退出码非 0 但无具名红例）'
  flush(`${mutant.id}: ${kind} —— ${String(result.failed.length)} 条红 —— ${mutant.claim}`)
  for (const name of result.failed.slice(0, 6)) appendFileSync(LOG, `    · ${name}\n`, 'utf8')
}

const survivors = lines.filter(line => line.includes('活下来') || line.includes('SKIPPED') || line.includes('崩了'))
flush(`结论：${String(MUTANTS.length - survivors.length)}/${String(MUTANTS.length)} 个变异被断言式抓住`)
