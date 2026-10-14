/**
 * #33（批准落账后批件被收回、状态仍 approved：唤醒永远不会来）的变异检验：
 * `recovery.ts` 里 compensate 的「先迁状态、迁赢了才收批件 + 半途失败必须出声」这两条守卫，改坏即红。
 *
 * 纪律照 `mutate-31.mjs`：一次只跑一份 harness、日志等进程退出后再读、变异期间不起产品。
 * 每个变异独立应用到 `recovery.ts` 副本，跑完立刻还原，所以任何一刻磁盘上只有一份变异。
 *
 * 「抓住」判定同前：先去 ANSI 色，再只按「有没有具名用例带 `×`」判。
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = 'F:/deepseek/deepseek harness/office-platform'
const RECOVERY = join(ROOT, 'plugins/office-approval/recovery.ts')

const MUTANTS = [
  {
    id: 'a-transition-failure-silent',
    claim: '退回写失败不再出声（吞掉 compensation-incomplete）—— 那条「必须报告」的断言必须红',
    file: RECOVERY,
    from: "      options.onFailure?.('compensation-incomplete', event, error)\n      return",
    to: "      return",
  },
  {
    id: 'b-revoke-before-transition',
    claim: '回到「先收批件再迁状态」的旧顺序（#33 原始死账）—— 退回失败时批件已被删，那条「批件没被收回」的断言必须红',
    file: RECOVERY,
    from: "    if (event.decision !== 'approve') return\n    let transitioned = false",
    to: "    if (event.decision !== 'approve') return\n    if (event.grantId !== undefined) await ledger.revokeGrant(event.grantId).catch(() => {})\n    let transitioned = false",
  },
  {
    id: 'c-treat-downgrade-throw-as-success',
    claim: '把「退回写抛错」当成成功继续收批件（approved 未退成却已删批件 = 死账）—— 批件留存与报告两条断言都必须红',
    file: RECOVERY,
    from: "    } catch (error) {\n      // 退回失败：绝不先删批件，留下 `approved` + 批件（可自愈），报告出去。\n      options.onFailure?.('compensation-incomplete', event, error)\n      return\n    }",
    to: "    } catch (error) {\n      transitioned = true\n    }",
  },
]

const SUITE = [join(ROOT, 'plugins/office-approval/recovery.spec.ts')]

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

const LOG = join(ROOT, '.spike/mutate-33.log')
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
