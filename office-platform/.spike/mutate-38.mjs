/**
 * #38（批准后 expire 告警仍 armed ⇒ 侧栏挂着幽灵自动化，且到点会把已完成的批准误作废）的变异检验：
 * sweeper 的三处判定（到期动作、重启补登记、挂载观察者）都把「approved 是否留着作废」绑到
 * 「有没有未消费的批件」上；ledger.approve 让权威通知排在批件落账之后。每条守卫改坏即红。
 *
 * 纪律照 `mutate-33.mjs`：一次只跑一份 harness、日志等进程退出后再读、变异期间不起产品。
 * 每个变异独立应用到副本，跑完立刻还原，所以任何一刻磁盘上只有一份变异。
 *
 * 「抓住」判定同前：先去 ANSI 色，再只按「有没有具名用例带 `×`」判。
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = 'F:/deepseek/deepseek harness/office-platform'
const SWEEPER = join(ROOT, 'plugins/office-approval/sweeper.ts')
const LEDGER = join(ROOT, 'plugins/office-approval/ledger.ts')

const MUTANTS = [
  {
    id: 'a-fire-drops-grant-gate',
    claim: '到期动作退回「approved 一律作废」（不看批件）—— 「已批且批件已消失 → skipped」那条必须红（会被误作废）',
    file: SWEEPER,
    from: "    const actionable = row.kind === 'remind'\n      ? isDecidable(record, at)\n      : record.status === 'approved'\n        ? ledger.hasOutstandingGrant(record.requestId)\n        : awaitsExpiry(record)",
    to: "    const actionable = row.kind === 'remind' ? isDecidable(record, at) : awaitsExpiry(record)",
  },
  {
    id: 'b-fire-inverts-grant-gate',
    claim: '到期动作把批件判定反过来（有批件反而不作废）—— 「批了但批件还在 → expired」那条必须红',
    file: SWEEPER,
    from: "      : record.status === 'approved'\n        ? ledger.hasOutstandingGrant(record.requestId)\n        : awaitsExpiry(record)",
    to: "      : record.status === 'approved'\n        ? !ledger.hasOutstandingGrant(record.requestId)\n        : awaitsExpiry(record)",
  },
  {
    id: 'c-scanopen-arms-approved-unconditionally',
    claim: '重启补登记回到「approved 无条件补作废」—— scanOpen 那条「窗口内批准不该再挂出幽灵 job」必须红',
    file: SWEEPER,
    from: "      if (record.status === 'approved') {\n        if (ledger.hasOutstandingGrant(record.requestId)) await armKind(record, 'expire', record.expiresAt)\n      } else await arm(record)",
    to: "      if (record.status === 'approved') {\n        await armKind(record, 'expire', record.expiresAt)\n      } else await arm(record)",
  },
  {
    id: 'd-observer-always-keeps-expire',
    claim: '挂载观察者退回「批准永远留着作废」—— install 那条「窗口内批准当场撤干净、catalog 归零」必须红',
    file: SWEEPER,
    from: "        return void sweeper.settle(record.requestId, options.ledger.hasOutstandingGrant(record.requestId))",
    to: "        return void sweeper.settle(record.requestId, true)",
  },
  {
    id: 'e-approve-notifies-before-grant',
    claim: 'approve 的通知排回批件落账之前（旧竞态）—— 迟到批准在观察者眼里没有批件 ⇒ 作废被撤，那条「批准只撤催办、留作废」必须红',
    file: LEDGER,
    from: "    try {\n      await this.grants.put(grant.grantId, grant)",
    to: "    this.#notify(requestId)\n    try {\n      await this.grants.put(grant.grantId, grant)",
  },
]

const SUITE = [join(ROOT, 'plugins/office-approval/sweeper.spec.ts'), join(ROOT, 'plugins/office-approval/ledger.spec.ts')]

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

const LOG = join(ROOT, '.spike/mutate-38.log')
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
  const original = await readFile(mutant.file, 'utf8')
  if (!original.includes(mutant.from)) {
    flush(`${mutant.id}: SKIPPED（锚点没找到，变异没应用）`)
    continue
  }
  await writeFile(mutant.file, original.replace(mutant.from, mutant.to), 'utf8')
  const result = runSuite()
  await writeFile(mutant.file, original, 'utf8')
  if (await readFile(mutant.file, 'utf8') !== original) throw new Error(`${mutant.id}: 还原失败`)
  flush(`${mutant.id}: ${result.caught ? '抓住' : '活下来'} —— ${String(result.failed.length)} 例红（exit=${String(result.exit)}）— ${mutant.claim}`)
  for (const name of result.failed.slice(0, 6)) appendFileSync(LOG, `    · ${name}\n`, 'utf8')
}

const survivors = lines.filter(line => line.includes('活下来') || line.includes('SKIPPED'))
flush(`结论：${String(MUTANTS.length - survivors.length)}/${String(MUTANTS.length)} 个变异被抓住`)
