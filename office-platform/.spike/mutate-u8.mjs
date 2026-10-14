/**
 * U8（策略 `never` 的档位不发可批卡 —— 配置面声明 + 断言 fail-closed）的变异检验。
 *
 * 定案＝设计 §9 候选①：不动 sweeper/gate 的行为接缝，把「never 会话里的残留催办卡」当成
 * **已声明的信息性噪声**收口。能这么收口的前提是一条必须被断言的不变量 —— 这张卡即便落了
 * `pending` 记录、即便批件真落到账上，也兑现不了任何执行。这个不变量的**两侧**：
 * - 我们这一侧的守卫（可变异）：`risk-gate.ts` 对 L3 提权写一律 `ask`（而不是 `allow`/交棒），
 *   且 ask 之前一定先 `ledger.snapshot` 落 `pending`（审计要留痕）。
 * - 内核那一侧的守卫（不可变异，铁律：packages/ 只读）：`never` 策略在任何 `approval/request`
 *   监听器之前就把提权判掉 ⇒ `responder.ts:134` 的 `consumeGrant` 根本跑不到 ⇒ 批件消费不掉。
 *   测试里的第三步（批件原封不动 + 动作不执行）断言的是这一侧，属于对内核事实的**特征化回归**
 *   （同 §8 第 8 步对 F-I/F-J 的处理），本轮如实登记为不可变异，而不是假装有一条自研守卫。
 *
 * 纪律照 `mutate-u9.mjs`：一次只跑一份 harness、日志等进程退出后再读、变异期间不起产品。
 * 「抓住」判定同前：先去 ANSI 色，再只按「有没有具名用例带 `×`」判。
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = 'F:/deepseek/deepseek harness/office-platform'
const GATE = join(ROOT, 'plugins/office-approval/risk-gate.ts')

const MUTANTS = [
  {
    id: 'a-escalated-l3-hands-off-as-allow',
    claim: '提权写（L3）不再 ask 而是像 L0/L1 一样交棒 —— never 会话里这次写会直接执行、且不再落 pending（U8 用例第一步的 `isError` 与 `req-gate-1` 双双红：fail-closed 的闸这一侧没了）',
    from: "    if (level === 'L0' || level === 'L1') return await next()",
    to: "    if (level === 'L0' || level === 'L1' || level === 'L3') return await next()",
  },
  {
    id: 'b-ask-without-pending-snapshot',
    claim: 'ask 之前不落台账快照（把 ledger.snapshot 换成空操作）—— 批件/审计记录凭空消失（U8 用例第一步的 get(req-gate-1).status 抛错即红：该档位仍要留痕这条没了）',
    from: '      await options.ledger.snapshot(record)',
    to: '      await Promise.resolve(record)',
  },
]

const SUITE = [join(ROOT, 'plugins/office-approval/responder.spec.ts')]

function runSuite() {
  let exit = 0
  let out = ''
  try {
    out = execFileSync(process.execPath, [
      join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', '--no-file-parallelism', ...SUITE,
    ], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 300_000 })
  } catch (error) {
    exit = typeof error.status === 'number' ? error.status : -1
    out = `${String(error.stdout ?? '')}${String(error.stderr ?? '')}`
  }
  const plain = out.replace(/\u001B\[[0-9;]*m/g, '')
  const failed = [...new Set(
    [...plain.matchAll(/×[^\n]*/g)].map(line => line[0].replace(/^×\s*/, '').replace(/\s+\d+m?s$/, '').trim()),
  )]
  return { caught: exit !== 0 && failed.length > 0, failed, exit, report: plain }
}

const LOG = join(ROOT, '.spike/mutate-u8.log')
const lines = []
const flush = (line) => {
  lines.push(line)
  appendFileSync(LOG, `${line}\n`, 'utf8')
  console.log(line)
}

writeFileSync(LOG, '', 'utf8')
const baseline = runSuite()
flush(`baseline: ${baseline.exit !== 0 ? `RED (${baseline.failed.join(' / ')}) —— 变异前就红，本轮结论不可信` : 'green'}`)
if (baseline.exit !== 0) {
  appendFileSync(LOG, `${baseline.report}\n`, 'utf8')
  process.exit(1)
}

for (const mutant of MUTANTS) {
  const original = await readFile(GATE, 'utf8')
  if (!original.includes(mutant.from)) {
    flush(`${mutant.id}: SKIPPED（锚点没找到，变异没应用）`)
    continue
  }
  await writeFile(GATE, original.replace(mutant.from, mutant.to), 'utf8')
  const result = runSuite()
  await writeFile(GATE, original, 'utf8')
  if (await readFile(GATE, 'utf8') !== original) throw new Error(`${mutant.id}: 还原失败`)
  flush(`${mutant.id}: ${result.caught ? '抓住' : '活下来'} —— ${String(result.failed.length)} 例红（exit=${String(result.exit)}）— ${mutant.claim}`)
  for (const name of result.failed.slice(0, 6)) appendFileSync(LOG, `    · ${name}\n`, 'utf8')
}

const survivors = lines.filter(line => line.includes('活下来') || line.includes('SKIPPED'))
flush(`结论：${String(MUTANTS.length - survivors.length)}/${String(MUTANTS.length)} 个变异被抓住`)
