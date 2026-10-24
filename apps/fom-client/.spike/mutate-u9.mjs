/**
 * U9（超窗作废后模型重试同一动作 ⇒ 两张都能批的卡，而「累计放宽」只数已批准的、重复隐形）的变异检验：
 * 渠道给卡片加了「本会话第 N 次为同一个动作请求放宽」这条人因防线，计数口径是
 * 「同工具 + 同参数指纹（剔 justification）、数所有状态」。每条守卫改坏即红。
 *
 * 纪律照 `mutate-38.mjs`：一次只跑一份 harness、日志等进程退出后再读、变异期间不起产品。
 * 每个变异独立应用到原件，跑完立刻还原并按字节校验，所以任何一刻磁盘上只有一份变异。
 *
 * 「抓住」判定同前：先去 ANSI 色，再只按「有没有具名用例带 `×`」判。
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = 'F:/deepseek/deepseek harness/apps/fom-client'
const CHANNEL = join(ROOT, 'plugins/office-approval/feishu-channel.ts')

const MUTANTS = [
  {
    id: 'a-card-drops-repeat-line',
    claim: '卡片不再渲染重复提示（`repeat > 1` 改成 `false`）—— install 默认策略那条「第二张卡标出第 2 次」必须红（U9 的可见性没了）',
    from: '        ...(repeat > 1',
    to: '        ...(false',
  },
  {
    id: 'b-repeat-ignores-args-digest',
    claim: '计数只按工具名、不比参数指纹（把 digest 比较删掉）—— 纯函数那条「换了另一个文件的 approved 仍只算 1 次」必须红（不同动作被并进同一计数）',
    from: '      other.toolName === record.toolName && digestOf(other) === digest).length',
    to: '      other.toolName === record.toolName).length',
  },
  {
    id: 'c-repeat-counts-only-approved',
    claim: '计数退回只认已批准/已消费（跟 relaxationCount 一样）—— 纯函数那条「pending + expired 两条 = 2」与 install 那条「超窗未批的第二张卡 = 第 2 次」都必须红（U9 现场里两张都没批 ⇒ 又变回隐形）',
    from: '    return ledger.requestsOf(record.sessionId).filter(other =>\n      other.toolName === record.toolName && digestOf(other) === digest).length',
    to: '    return ledger.requestsOf(record.sessionId).filter(other =>\n      (other.status === \'approved\' || other.status === \'consumed\')\n      && other.toolName === record.toolName && digestOf(other) === digest).length',
  },
  {
    id: 'd-repeat-digest-not-strip-justification',
    claim: '指纹退回比原文（不剔 justification，改用 JSON.stringify）—— 纯函数那条「只改 justification 仍算同一个动作 = 2」与 install 那条「重试时重写说明仍 = 第 2 次」都必须红（§3.4.1① 的口径漂移）',
    from: '  const digestOf = (record: ApprovalRequestRecord): string =>\n    argsDigest(record.toolArgs as Record<string, unknown>)',
    to: '  const digestOf = (record: ApprovalRequestRecord): string =>\n    JSON.stringify(record.toolArgs)',
  },
]

const SUITE = [join(ROOT, 'plugins/office-approval/feishu-channel.spec.ts')]

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

const LOG = join(ROOT, '.spike/mutate-u9.log')
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
  const original = await readFile(CHANNEL, 'utf8')
  if (!original.includes(mutant.from)) {
    flush(`${mutant.id}: SKIPPED（锚点没找到，变异没应用）`)
    continue
  }
  await writeFile(CHANNEL, original.replace(mutant.from, mutant.to), 'utf8')
  const result = runSuite()
  await writeFile(CHANNEL, original, 'utf8')
  if (await readFile(CHANNEL, 'utf8') !== original) throw new Error(`${mutant.id}: 还原失败`)
  flush(`${mutant.id}: ${result.caught ? '抓住' : '活下来'} —— ${String(result.failed.length)} 例红（exit=${String(result.exit)}）— ${mutant.claim}`)
  for (const name of result.failed.slice(0, 6)) appendFileSync(LOG, `    · ${name}\n`, 'utf8')
}

const survivors = lines.filter(line => line.includes('活下来') || line.includes('SKIPPED'))
flush(`结论：${String(MUTANTS.length - survivors.length)}/${String(MUTANTS.length)} 个变异被抓住`)
