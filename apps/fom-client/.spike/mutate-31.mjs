/**
 * #31（多渠道收件人共用 uuid 被飞书去重吃掉第二条）的变异检验：
 * 逐收件人 uuid 这个守卫，改坏即红。
 *
 * 纪律照 `mutate-a2.mjs` / `fe-mutation.mjs`：一次只跑一份 harness、日志等进程退出后再读、
 * 变异期间不起产品。每个变异独立应用到 `feishu-channel.ts` 副本，跑完立刻还原，
 * 所以任何一刻磁盘上只有一份变异。
 *
 * 「抓住」判定同前：先去 ANSI 色，再只按「有没有具名用例带 `×`」判 —— 带色读 stdout 会把
 * 没守卫的代码说成有守卫。
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = 'F:/deepseek/deepseek harness/apps/fom-client'
const CHANNEL = join(ROOT, 'plugins/office-approval/feishu-channel.ts')

const MUTANTS = [
  {
    id: 'a-digest-drops-recipient',
    claim: 'uuidDigest 不再把收件人并进摘要（回到「只按编号哈希」）—— 不同收件人撞同一 uuid，长度钉死用例的「ou-alice≠ou-bob」必须红',
    file: CHANNEL,
    // 源码里这行含反引号模板与字面量 `\u0000`；这里用普通字符串，`\\u0000` 还原成字面反斜杠-u。
    from: "  return createHash('sha1').update(`${requestId}\\u0000${recipient}`, 'utf8').digest('hex').slice(0, 24)",
    to: "  return createHash('sha1').update(`${requestId}`, 'utf8').digest('hex').slice(0, 24)",
  },
  {
    id: 'b-sendcard-one-uuid-for-all',
    claim: 'sendCard 给所有收件人复用第一个人的 uuid（#31 原始形态）—— 多收件人发卡上真传输的两条 uuid 必须相等，那条断言必须红',
    file: CHANNEL,
    from: "          uuid: cardUuid(record.requestId, attempt, openId),",
    to: "          uuid: cardUuid(record.requestId, attempt, recipients[0]!),",
  },
  {
    id: 'c-notice-one-uuid-for-all',
    claim: '撤回通知给所有收件人复用同一个 uuid —— 第二条「已撤回」会被去重吃掉，撤回多收件人通知的两条 uuid 必须各异，那条断言必须红',
    file: CHANNEL,
    from: "        uuid: noticeUuid(requestId, openId),",
    to: "        uuid: noticeUuid(requestId, 'ou-fixed'),",
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

const LOG = join(ROOT, '.spike/mutate-31.log')
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
