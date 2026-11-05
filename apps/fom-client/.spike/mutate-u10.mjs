/**
 * U10（窗口内批准的一致性：批件存在期 + 卡片置灰 + toast 时态三条症状同一个根因）的变异检验：
 * 回调路由现在**先把结局交给活着的同步窗口**（`handToWindow`），交到了就不落批件、不 notify 恢复路径，
 * 让 responder 赢下 `pending→approved` 的 CAS 并置灰卡片；交不到才走唤醒重放（落批件 + 通知）。
 * 四条守卫各改坏一条，对应的用例必须红 —— 否则那条守卫根本没被断言到（假测试）。
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
const ROUTE = join(ROOT, 'plugins/office-approval/callback-route.ts')

const APPROVE_HANDOFF = [
  "    if (options.handToWindow?.(record.requestId, { decision: 'approve', openId })) {",
  "      return { status: 200, body: ok('已批准，这次调用已经在当前回合执行。') }",
  "    }",
].join('\n')

const REJECT_HANDOFF = [
  "      if (options.handToWindow?.(record.requestId, { decision: 'reject', openId })) {",
  "        return { status: 200, body: ok('已拒绝，我会把这个结果告诉发起人。') }",
  "      }",
  "",
].join('\n')

const MUTANTS = [
  {
    id: 'a-approve-drops-window-handoff',
    claim: '批准不再先交给活窗口（退回「总是落批件 + 通知」）—— 窗口内批准那条「不落批件、记录留 pending」必须红（§3.4.2 存在期重新打开）',
    from: APPROVE_HANDOFF,
    to: '',
  },
  {
    id: 'b-approve-window-path-still-notifies',
    claim: '窗口路径交到了还去 notify 恢复路径 —— 「活窗口接住批准 ⇒ settled 为空」那条必须红（起第二个 turn 重复唤醒）',
    from: APPROVE_HANDOFF,
    to: [
      "    if (options.handToWindow?.(record.requestId, { decision: 'approve', openId })) {",
      "      settle({ record: recordNow(record.requestId), decision: 'approve' })",
      "      return { status: 200, body: ok('已批准，这次调用已经在当前回合执行。') }",
      "    }",
    ].join('\n'),
  },
  {
    id: 'c-reject-drops-window-handoff',
    claim: '拒绝不再先交给活窗口（路由抢先迁 rejected）—— 「活窗口接住拒绝 ⇒ 记录留 pending 且 handoff 被调」那条必须红（responder 输 CAS、卡片不置灰）',
    from: REJECT_HANDOFF,
    to: '',
  },
  {
    id: 'd-approve-window-toast-wrong-tense',
    claim: '窗口路径的 toast 退回「下一个回合」措辞 —— 「当前回合已经执行」那条断言必须红（U10 的时态谎言）',
    from: "      return { status: 200, body: ok('已批准，这次调用已经在当前回合执行。') }",
    to: "      return { status: 200, body: ok('已批准，这个动作会在下一个回合自动执行一次。') }",
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
  return { caught: exit !== 0 && failed.length > 0, failed, exit, report: plain }
}

const LOG = join(ROOT, '.spike/mutate-u10.log')
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
  const original = await readFile(ROUTE, 'utf8')
  if (!original.includes(mutant.from)) {
    flush(`${mutant.id}: SKIPPED（锚点没找到，变异没应用）`)
    continue
  }
  await writeFile(ROUTE, original.replace(mutant.from, mutant.to), 'utf8')
  const result = runSuite()
  await writeFile(ROUTE, original, 'utf8')
  if (await readFile(ROUTE, 'utf8') !== original) throw new Error(`${mutant.id}: 还原失败`)
  flush(`${mutant.id}: ${result.caught ? '抓住' : '活下来'} —— ${String(result.failed.length)} 例红（exit=${String(result.exit)}）— ${mutant.claim}`)
  for (const name of result.failed.slice(0, 6)) appendFileSync(LOG, `    · ${name}\n`, 'utf8')
}

const survivors = lines.filter(line => line.includes('活下来') || line.includes('SKIPPED'))
flush(`结论：${String(MUTANTS.length - survivors.length)}/${String(MUTANTS.length)} 个变异被抓住`)
