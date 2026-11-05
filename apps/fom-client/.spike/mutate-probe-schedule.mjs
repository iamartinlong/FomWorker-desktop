/**
 * 收口探针 `.spike/probe-schedule-shape.ts` 的变异检验：把它每一个**决策**逐个改坏，看
 * `.spike/selftest-probe-schedule.ts` 是否出具名红例（`✗`）。
 *
 * 为什么探针这一腿要有自己的变异：它存在的理由是 §8 第 8 条那句未证前提——「内核真写出的那一行 `daily`，
 * 判据认得出吗」。旧那份 `.mjs` 只印键名，把「形状像」当成「认得出」，于是那一夜可能出现「探针全绿、判据全红」
 * 而没人知道两者读的不是同一件事。所以探针的每条出口码分支（读不到／读不成／没 daily 形／有 daily 形却零归属／
 * 列集合缺／列集合多／正向痕迹）都必须各有红例对着，其中 `g` 那一枪打的正是「探针不再与判据同源」这个原缺陷。
 *
 * 变异只打在 `.spike` 仪器上，**产品码一字节不动**。
 *
 * 纪律照 `mutate-step6-nightly.mjs`：一次只跑一份 harness、日志等进程退出后再读、变异期间不起产品。
 * 每个变异独立应用到原件、跑完立刻还原并按字节校验，任何一刻磁盘上只有一份变异。
 *
 * 判红口径：先去 ANSI，再只按「这行有没有 `✗`」判；只有退出码非 0 而没有具名红例的，单独标出来（那是崩了，不是抓住）。
 *
 * 跑法：node "F:/deepseek/deepseek harness/apps/fom-client/.spike/mutate-probe-schedule.mjs"
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = 'F:/deepseek/deepseek harness/apps/fom-client'
const KERNEL = 'F:/deepseek/deepseek harness/deepseek-harness'
const TARGET = join(ROOT, '.spike/probe-schedule-shape.ts')
const SELFTEST = join(ROOT, '.spike/selftest-probe-schedule.ts')

const MUTANTS = [
  {
    id: 'a-drift-reported-as-not-armed',
    claim: '「有 daily 形却零归属」与「文档里没有 daily 形」合成同一个出口码 3 —— ③ 必须红：`arm.ts` 的文案与内核写出的那两列漂了，探针却报告「还没武装」，人就去找蒸馏进程而不去核文案，第 5 枪照样红成谜',
    from: '    return daily === 0',
    to: '    return true',
  },
  {
    id: 'b-not-armed-reported-as-drift',
    claim: '反向合成：把「文档里没有任何 daily 形」也报成出口码 1 —— ④ 必须红：观测当天第 5 枪还没跑时探针会喊「跑坏了」，而实情是「还没跑到」（pending 与 fail 的方向别过无数次）',
    from: '    return daily === 0',
    to: '    return false',
  },
  {
    id: 'c-column-set-check-off',
    claim: '整个列集合比较不做了 —— ⑤ 与 ⑥ 必须红：内核换列（少 `time` ⇒ 判据静默读成空串；多一列 ⇒ 这份文档不是这版内核写的）时探针仍报「形状相符」，那句未证前提就被当成已证',
    from: '  if (shapeProblems.length > 0) {',
    to: '  if (false) {',
  },
  {
    id: 'd-extra-columns-ignored',
    claim: '只比「少列」、不比「多列」 —— ⑥ 必须红：多出来的列意味着 fixture 与真文档已经不同代，判据读到的列集合不再受 `DailyScheduleRecord` 保护',
    from: '    const extra = row.recordKeys.filter(key => !DAILY_RECORD_KEYS.includes(key))',
    to: '    const extra: string[] = []',
  },
  {
    id: 'e-no-positive-trace',
    claim: '开头那行「自报家门」的结构输出不写了（出口码照旧）—— 全部例子必须红：那一夜的结论必须对得上它读的是哪份 `schedule.json`（数据根可能不是本机默认），而仪器层老口径是「`EXIT=0` ＋ 没有可核对的痕迹＝没跑，不是通过」',
    from: '  const lines = [`scheduleFile=${file}`]',
    to: '  const lines: string[] = []',
  },
  {
    id: 'f-probe-owns-its-own-attribution',
    claim: '探针改回自己判归属（按 `kind=daily` 计数，而不是按判据那份「标题或正文与 `arm.ts` 常量逐字相等」的行）—— ③ 必须红：这正是原缺陷，「形状像」被当成「认得出」，于是探针全绿而 `nightly-job-single` 全红、两者读的从来不是同一件事',
    from: '  if (snapshot.rows.length === 0) {',
    to: '  if ((snapshot.kindCounts.daily ?? 0) === 0) {',
  },
  {
    id: 'g-missing-file-read-as-empty',
    claim: '拆掉「文件读不到」这一支 —— ⑧ 必须红：数据根不是本机默认时拿错路径，会被读成「调度层是空的」，那一夜的判定全线失真',
    from: '  if (!snapshot.exists) return {',
    to: '  if (false) return {',
  },
  {
    id: 'h-unreadable-doc-read-as-empty',
    claim: '拆掉「文档读不成」这一支 —— ⑨ 与 ⑩ 必须红：半截 JSON 与信封换形都会被读成「调度层里真没有夜间任务」（出口码 3），而实情是观测拿错了文件',
    from: "  if (snapshot.error !== '') return {",
    to: '  if (false) return {',
  },
]

function runSelftest() {
  let exit = 0
  let out = ''
  try {
    out = execFileSync(process.execPath, ['--import', 'tsx/esm', SELFTEST], {
      cwd: KERNEL, encoding: 'utf8', stdio: 'pipe', timeout: 600_000,
    })
  } catch (error) {
    exit = typeof error.status === 'number' ? error.status : -1
    out = `${String(error.stdout ?? '')}${String(error.stderr ?? '')}`
  }
  const plain = out.replace(/\u001B\[[0-9;]*m/g, '')
  const failed = [...new Set([...plain.matchAll(/^✗ (.+)$/gm)].map(match => match[1].trim()))]
  return { exit, failed, green: plain.includes('PASS 调度层收口探针自证') }
}

const LOG = join(ROOT, '.spike/mutate-probe-schedule.log')
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
