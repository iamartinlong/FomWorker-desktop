/**
 * U11 量尺（`.spike/u11-report.ts`）的变异检验：把每条守卫逐个改坏，看 `selftest-u11.ts` 是否红。
 *
 * 为什么统计件也要走这一腿：这把尺不拦住任何一次坏动作 —— 它只产出一个数。
 * 数错了没人会当场报错，只会在验收周结束时把一个本该改的档位读成「不用改」。
 * 所以「每条断言都真的在断言」在这里是唯一的证明手段，跟审批层的闸同等重要。
 *
 * 纪律照 `mutate-u9.mjs`：一次只跑一份 harness、日志等进程退出后再读、变异期间不起产品。
 * 每个变异独立应用到原件，跑完立刻还原并按字节校验，所以任何一刻磁盘上只有一份变异。
 *
 * 「抓住」判定：先去 ANSI 色，再按 selftest 的 `✗` 行数判；若变异让自检直接崩（`自检本身跑坏了`），
 * 记为「跑坏」—— 同样算依赖到了，但不是断言式抓住，日志里分开写。
 *
 * 跑法：node "F:/deepseek/deepseek harness/apps/fom-client/.spike/mutate-u11.mjs"
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = 'F:/deepseek/deepseek harness/apps/fom-client'
const KERNEL = 'F:/deepseek/deepseek harness/deepseek-harness'
const TARGET = join(ROOT, '.spike/u11-report.ts')
const SELFTEST = join(ROOT, '.spike/selftest-u11.ts')

const MUTANTS = [
  {
    id: 'a-search-substring-match',
    claim: '检索类改回子串匹配（`includes`）—— 「名字里含着 `web_search` 的 `internal_web_search` 不进分子」那条必须红：分子从 4 涨到 5，占比虚高，U11 会把不该改的档位读成「检索卡很烦」',
    from: '    if (searchNames.has(record.toolName)) {',
    to: '    if ([...searchNames].some(name => record.toolName.includes(name))) {',
  },
  {
    id: 'b-digest-keeps-justification',
    claim: '重复询问的指纹退回比参数原文（不剔 `justification`）—— 「只差理由的两次算同一组」必须红：组散了，尺子看不见 U9 已经在卡片上标出来的那次重复',
    from: '    const digest = argsDigest(record.toolArgs as Record<string, unknown>)',
    to: '    const digest = JSON.stringify(record.toolArgs)',
  },
  {
    id: 'c-repeat-key-drops-session',
    claim: '重复归组跨会话并组（键里去掉 `sessionId`）—— 「跨会话不并组」必须红：`maxRepeat` 从 2 变 3，卡片语义（本会话第 N 次）被统计件改写',
    from: '    const key = `${record.sessionId}|${record.toolName}|${digest}`',
    to: '    const key = `${record.toolName}|${digest}`',
  },
  {
    id: 'd-share-denominator-all-records',
    claim: '占比的分母用全部记录（含窗口外）—— 「窗口外那条不进分母」必须红：窗口过滤成了装饰，验收周会被读成「今天卡少」',
    from: 'acc.counts.search / acc.counts.counted,',
    to: 'acc.counts.search / records.length,',
  },
  {
    id: 'e-empty-window-nan-share',
    claim: '去掉空窗口的 0 兜底（`0/0`）—— 「空账本占比是 0 不是 NaN」必须红：NaN 一旦进了报告，「没数据」和「占比很低」肉眼分不开',
    from: 'acc.counts.counted === 0 ? 0 :',
    to: 'acc.counts.counted === 1 ? 0 :',
  },
  {
    id: 'f-no-shape-guard',
    claim: '不做形状判定（`isReadable` 恒假）—— 「读不懂的行被点名、且不进分母」必须红：坏行会被静默算进窗口外，等于丢行不报',
    from: '    if (!isReadable(record)) {',
    to: '    if (false) {',
  },
  {
    id: 'g-decision-bucket-flip',
    claim: '裁决分桶比错对象（拿 `askedAt` 当窗口末）—— 「窗口内 1 / 超窗 2 / 还在等 3」必须红：这是 U11 判断「等人批 vs 秒批」的唯一依据',
    from: '    else if (record.decidedAt <= record.windowEndsAt) acc.counts.inWindow += 1',
    to: '    else if (record.decidedAt < record.askedAt) acc.counts.inWindow += 1',
  },
  {
    id: 'h-toolname-becomes-body',
    claim: '工具名换成动作摘要（正文进聚合）—— 三条「正文零泄漏」必须一起红：统计件把 `actionSummary` 带到终端与 `--out`，§4 最小暴露就破了',
    from: '    bump(acc.tools, record.toolName)',
    to: '    bump(acc.tools, record.actionSummary)',
  },
  {
    id: 'i-dropped-rows-not-reported',
    claim: '丢行不再进警告（也不决定退出码）—— 「有行没读回来 ⇒ 退出码 1 且点名」必须红：这是「分母少了就是假绿」唯一的那道闸',
    from: '  if (dropped.length > 0) warnings.push(',
    to: '  if (false) warnings.push(',
  },
  {
    id: 'j-empty-window-exits-zero',
    claim: '窗口内 0 条时报 0（成功）—— 「窗口里一条都没有 ⇒ 退出码 1 + 报告自陈窗口外几条」必须红：验收周脚本会把「没采到数」当成「没人被卡」',
    from: '  if (summary.counted === 0) {',
    to: '  if (false) {',
  },
  {
    id: 'k-missing-ledger-exits-zero',
    claim: '台账目录不存在时不报警 —— 「没这本账」与「账是空的」必须红：路径写错的那一周会交出一份 0 张卡的报告',
    from: '  if (dirMissing) warnings.push(',
    to: '  if (false) warnings.push(',
  },
  {
    id: 'l-json-flag-eats-a-value',
    claim: '`--json` 当成要吃值的键 —— 「`--json` 不吃下一个值」与「缺 `--storage-root` 时说的是这一句」必须红：开关顺序一变就报一句假错，真错被埋',
    from: "    if (flag === '--json') {",
    to: "    if (flag === '--JSON') {",
  },
]

function runSelftest() {
  let exit = 0
  let out = ''
  try {
    out = execFileSync(process.execPath, ['--import', 'tsx/esm', SELFTEST], {
      cwd: KERNEL, encoding: 'utf8', stdio: 'pipe', timeout: 300_000,
    })
  } catch (error) {
    exit = typeof error.status === 'number' ? error.status : -1
    out = `${String(error.stdout ?? '')}${String(error.stderr ?? '')}`
  }
  const plain = out.replace(/\u001B\[[0-9;]*m/g, '')
  const failed = [...new Set([...plain.matchAll(/✗ (.+)/g)].map(m => m[1].trim()))]
  return { exit, failed, crashed: plain.includes('自检本身跑坏了'), green: plain.includes('全绿'), report: plain }
}

const LOG = join(ROOT, '.spike/mutate-u11.log')
const lines = []
const flush = (line) => {
  lines.push(line)
  appendFileSync(LOG, `${line}\n`, 'utf8')
  console.log(line)
}

writeFileSync(LOG, '', 'utf8')
const baseline = runSelftest()
flush(`baseline: ${baseline.exit === 0 && baseline.green ? `green（0 红）` : `RED (exit=${baseline.exit} failed=${String(baseline.failed.length)} crashed=${String(baseline.crashed)}) —— 变异前就红，本轮结论不可信`}`)
if (!(baseline.exit === 0 && baseline.green)) {
  appendFileSync(LOG, `${baseline.report}\n`, 'utf8')
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
  const kind = result.failed.length > 0 ? '抓住（断言式）' : result.crashed ? '抓住（跑坏，非断言）' : result.exit === 0 ? '活下来' : '抓住（退出码非 0 但无具名红例）'
  flush(`${mutant.id}: ${kind} —— ${String(result.failed.length)} 条红 —— ${mutant.claim}`)
  for (const name of result.failed.slice(0, 6)) appendFileSync(LOG, `    · ${name}\n`, 'utf8')
}

const survivors = lines.filter(line => line.includes('活下来') || line.includes('SKIPPED'))
flush(`结论：${String(MUTANTS.length - survivors.length)}/${String(MUTANTS.length)} 个变异被抓住`)
