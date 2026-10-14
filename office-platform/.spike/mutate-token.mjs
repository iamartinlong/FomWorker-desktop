/**
 * #58（空 Verification Token 的伪造批准面）的变异检验。
 *
 * 纪律照 `mutate-a2.mjs`：一次只跑一份 harness、日志等进程退出后再读、变异期间不起产品；
 * 每个变异独立应用到源码副本、跑完立刻还原，所以任何一刻磁盘上都只有一份变异。
 *
 * 判据：该变异必须让至少一条用例变红。绿 = 那道守卫没被断言 = 测试是假的。
 * 判定前先去 ANSI 色，再只按「这行有没有 `×`」判（`.spike/fe-mutation.mjs:3-6` 的教训）。
 *
 * 基线不是「跑之前绿就行」：k（去掉守卫）的对照事实是**修复前实测伪造回调返回 200**，
 * 所以 k 必红这件事本身就是那道 fail-open 曾被真实触发的回归锚。
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = 'F:/deepseek/deepseek harness/office-platform'
const ROUTE = join(ROOT, 'plugins/office-approval/callback-route.ts')

const GUARD = "    if (options.verificationToken() === '') {"

const MUTANTS = [
  {
    id: 'k-token-guard-removed',
    claim: '去掉「空 token ⇒ 一律 401」这道守卫 —— 回到修复前那个用空串就能现算出合法签名的形态，两条新用例必红',
    file: ROUTE,
    from: GUARD,
    to: '    if (false) {',
  },
  {
    id: 'l-token-guard-inverted',
    claim: '反转这道守卫（配了 token 反而全拒、没配才放行）—— 验签整段废掉，既有那二十八条必红',
    file: ROUTE,
    from: GUARD,
    to: "    if (options.verificationToken() !== '') {",
  },
]

const SUITE = [join(ROOT, 'plugins/office-approval/callback-route.spec.ts')]

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
  // 「跑不起来」与「没被抓住」必须分开：退出码非 0 但一条具名用例都没红，多半是语法/解析炸了。
  return { caught: exit !== 0 && failed.length > 0, failed, exit, report: plain }
}

const LOG = join(ROOT, '.spike/mutate-token.log')
const lines = []
const flush = (line) => {
  lines.push(line)
  appendFileSync(LOG, `${line}\n`, 'utf8')
  console.log(line)
}

writeFileSync(LOG, '', 'utf8')
const baseline = runSuite()
flush(`baseline: ${baseline.caught || baseline.exit !== 0 ? `RED (${baseline.failed.join(' / ')}) —— 变异前就红，本轮结论不可信` : 'green'}`)
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
