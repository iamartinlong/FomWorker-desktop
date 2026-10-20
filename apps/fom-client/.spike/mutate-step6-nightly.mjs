/**
 * 第 6 步判据机 `.spike/verify-step6.ts` 里**第 5 枪那条判定**（`nightly-job-single`）的变异检验：
 * 把它的每一个分支逐个改坏，看 `.spike/selftest-verify-step6.ts` 是否出**具名红例**。
 *
 * 为什么这条判定要有自己的一腿变异：它是这一轮新加的，加它的理由正是「旧观测看不见调度层那一侧的坏」——
 * 标记与任务行各说一件事时 `armed-marker` 照报绿、堆叠 recurring 任务时整夜被叫醒多次而磁盘上没有任何差值。
 * 一条没人踩过的守卫等于没有守卫，所以这 11 个分支（残留／文件不在场／文档读不成／标记指向的行没了／堆叠／
 * 四列形状／缺列宽容／归属过滤）必须各有红例对着。
 *
 * 变异只打在 `.spike` 仪器上，**产品码一字节不动**（`plugins/**` 与门禁无关的这一轮没有改动）。
 *
 * 纪律照 `mutate-u11.mjs` / `mutate-step6-baseline.mjs`：一次只跑一份 harness、日志等进程退出后再读、
 * 变异期间不起产品。每个变异独立应用到原件、跑完立刻还原并按字节校验，任何一刻磁盘上只有一份变异。
 *
 * 判红口径（`.spike/fe-mutation.mjs:3-6` 的教训）：先去 ANSI，再只按「这行有没有 `×`」判；
 * 只有退出码非 0 而没有具名红例的，单独标出来（那是崩了，不是抓住）。
 *
 * 跑法：node "F:/deepseek/deepseek harness/apps/fom-client/.spike/mutate-step6-nightly.mjs"
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = 'F:/deepseek/deepseek harness/apps/fom-client'
const KERNEL = 'F:/deepseek/deepseek harness/deepseek-harness'
const TARGET = join(ROOT, '.spike/verify-step6.ts')
const SELFTEST = join(ROOT, '.spike/selftest-verify-step6.ts')
const SEED = join(ROOT, '.spike/distill-workspace')

const MUTANTS = [
  {
    id: 'a-orphan-task-read-as-pending',
    claim: '「调度层挂着夜间任务而标记不在场」从 fail 放宽成 pending —— ⑬ 必须红：残留的那条会在 03:30 叫醒一个没人观测的蒸馏会话，而早上那张表把它读成「还没武装」',
    from: "      schedule.rows.length === 0 ? 'pending' : 'fail',",
    to: "      schedule.rows.length === 0 ? 'pending' : 'pending',",
  },
  {
    id: 'b-file-absent-branch-off',
    claim: '拆掉「标记在场而调度层文档不在场」这一支 —— ⑪ 与 ⑪b 必须红：拿错 `--schedule-file` 会被说成「任务已被取消」，人就去重装任务而不是改路径',
    from: '  } else if (!schedule.exists) {',
    to: '  } else if (false) {',
  },
  {
    id: 'c-parse-error-branch-off',
    claim: '拆掉「文档读不成」这一支 —— ⑭ 与 ⑭b 必须红：半截 JSON 会被读成「调度层里真没有夜间任务」，而实情是观测拿错了文件',
    from: "  } else if (schedule.error !== '') {",
    to: '  } else if (false) {',
  },
  {
    id: 'd-marker-row-divergence-relaxed',
    claim: '「标记指向的行不在夜间任务行里」那一支从 fail 放宽成 pass（取消任务后「别让早上那张表卡住」的诱人写法）—— ⑩ 与 ⑩b 必须红：内核取消是真删行、没有墓碑，标记还在而 nightly 永不点火，`armed-marker` 那一侧照样绿，这条判定存在的唯一理由就是把这个形状拦住',
    from: "  } else if (onlyRow === undefined) {\n    push('nightly-job-single', '夜间任务与武装标记同源且只有一条（MF4／第 5 枪）', 'fail',\n      schedule.rows.length === 0",
    to: "  } else if (onlyRow === undefined) {\n    push('nightly-job-single', '夜间任务与武装标记同源且只有一条（MF4／第 5 枪）', 'pass',\n      schedule.rows.length === 0",
  },
  {
    id: 'e-stack-threshold-raised',
    claim: '堆叠阈值从 >1 抬到 >2 —— ⑨ 必须红：MF4 没有幂等键，重启堆出两条 recurring 就只报绿，03:30 被叫醒两次、侧栏挂着两条自动化',
    from: '  } else if (schedule.rows.length > 1) {',
    to: '  } else if (schedule.rows.length > 2) {',
  },
  {
    id: 'f-kind-column-check-off',
    claim: '去掉 `kind` 必须是 daily 的比较 —— ⑫ 的 kind 例必须红：`at`／`cron` 形的行会被当成每日夜间任务，而它要么只点火一次、要么按另一套表达式走',
    from: "        ...(onlyRow.kind !== 'daily' ? [`kind=${onlyRow.kind}（要 daily）`] : []),",
    to: '',
  },
  {
    id: 'g-time-column-check-off',
    claim: '去掉 `time` 与 `arm.ts` 常量的比较 —— ⑫ 的 time 例必须红：任务确实挂着但叫醒的时刻不是 03:30，第 5 枪「幂等」的结论来自一条被改过时刻的任务',
    from: '        ...(onlyRow.time !== DISTILL_TIME ? [`time=${onlyRow.time || \'(空)\'}（要 ${DISTILL_TIME}）`] : []),',
    to: '',
  },
  {
    id: 'h-timezone-column-check-off',
    claim: '去掉 `timeZone` 与 `arm.ts` 常量的比较 —— ⑫ 的 timeZone 例必须红：UTC 的 03:30 是上海的 11:30，蒸馏会在白天叫醒、还会往成员的语料里插话',
    from: '        ...(onlyRow.timeZone !== DISTILL_TIME_ZONE ? [`timeZone=${onlyRow.timeZone || \'(空)\'}（要 ${DISTILL_TIME_ZONE}）`] : []),',
    to: '',
  },
  {
    id: 'i-status-column-check-off',
    claim: '去掉 `status` 必须是 active 的比较 —— ⑫ 的 status 例必须红：真文档 39 行里就有 inactive 的，inactive 的行到点不再投递，标记却照样绿',
    from: "        ...(onlyRow.status !== 'active' ? [`status=${onlyRow.status}（到点不会再点火）`] : []),",
    to: '',
  },
  {
    id: 'j-missing-status-column-flipped',
    claim: '行没写 `status` 列时按 inactive 处理（内核 schema 里那是带 default 的列）—— ⑧b 必须红：一条本来会点火的被说成永不点火，第 5 枪出现假红就等于这一夜作废',
    from: "      status: task.status === undefined ? 'active' : String(task.status),",
    to: "      status: task.status === undefined ? 'inactive' : String(task.status),",
  },
  {
    id: 'k-attribution-filter-off',
    claim: '去掉「只认标题/正文与 `arm.ts` 常量逐字相等的那几行」的归属过滤 —— ⑧c 必须红：那份 `schedule.json` 是跨实例共享的（本机 39 行全是审批催办那一形），把别人的任务算进来就会凭空造出「堆叠」假红、或把我这条挤进别人的行',
    from: '    if (title !== DISTILL_TITLE && prompt !== DISTILL_PROMPT) return []',
    to: "    if (title === '' && prompt === '') return []",
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
  const failed = [...new Set([...plain.matchAll(/^× (.+)$/gm)].map(match => match[1].trim()))]
  return { exit, failed, green: plain.includes('PASS verify-step6 判定自证') }
}

const LOG = join(ROOT, '.spike/mutate-step6-nightly.log')
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
