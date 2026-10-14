/**
 * 记忆层第 5 步的变异检验（蒸馏守卫：DM8 幂等 / ME2 手改保护 / ME3 加法幂等 / ME10 单写者不悬空）。
 *
 * 纪律照上一轮：一次只跑一份 harness、日志等进程退出后再读、变异期间不起产品；每个变异独立应用、
 * 跑完立刻还原，磁盘任何一刻只有一份变异。判据：该变异必须让至少一条用例变红，绿 = 守卫没被断言。
 * 「抓住」判定先去 ANSI 色、再按「这行有没有 ×」（`.spike/fe-mutation.mjs` 的教训）。
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = 'F:/deepseek/deepseek harness/office-platform'
const DISTILL = join(ROOT, 'plugins/office-memory/distill.ts')
const ARM = join(ROOT, 'plugins/office-memory/arm.ts')
const STORE = join(ROOT, 'plugins/office-memory/store.ts')

const MUTANTS = [
  {
    id: 'm24-noop-gate-off',
    claim: '去掉水位线幂等闸 —— 没有新日级也照常重写并记 distilled（DM8）',
    file: DISTILL,
    from: '  if (newDays.length === 0) {',
    to: '  if (false) {',
  },
  {
    id: 'm25-evict-handedited',
    claim: '拆掉超线手改条目的保护 —— 人手编辑过的内容被自动淘汰（ME2）',
    file: DISTILL,
    from: '    if (entry.handEdited) {',
    to: '    if (false && entry.handEdited) {',
  },
  {
    id: 'm26-budget-ignored',
    claim: '忽略 maxLines —— 谁都不淘汰，蒸馏的重排形同虚设',
    file: DISTILL,
    from: '    if (index < budget.maxLines) {',
    to: '    if (true) {',
  },
  {
    id: 'm27-index-not-overwritten',
    claim: '重建时干脆不写索引 —— 归档了文件、MEMORY.md 仍带悬空行（ME10）',
    file: DISTILL,
    from: '  await deps.store.writeIndex(renderIndex(plan.kept))',
    to: '  void renderIndex(plan.kept)',
  },
  {
    id: 'm28-watermark-not-advanced',
    claim: '蒸馏成功却不前移水位线 —— 同一批日级每晚重蒸（DM8 / ME3）',
    file: DISTILL,
    from: '  await deps.store.writeWatermark(startedAt, lastDay)',
    to: '  void lastDay',
  },
  {
    id: 'm29-undated-penalized',
    claim: '无 createdAt 不按 0 天处理而按坏值 —— 手写条目被当成极旧先淘汰',
    file: DISTILL,
    from: "  if (createdAt === '') return 0",
    to: "  if (createdAt === '') return 9999",
  },
  {
    id: 'm30-index-includes-evicted',
    claim: '整段重建把被淘汰条目也写回索引 —— ME10 无悬空失效（链接指向已归档文件）',
    file: DISTILL,
    from: '  await deps.store.writeIndex(renderIndex(plan.kept))',
    to: '  await deps.store.writeIndex(renderIndex([...plan.kept, ...plan.evictions]))',
  },
  {
    id: 'm31-arm-never-skips',
    claim: '武装不读标记 —— 每次启动堆一条 recurring 任务（重启噪声 / 幽灵自动化）',
    file: ARM,
    from: '  const existing = await store.readArmedJob()',
    to: '  const existing = undefined as string | undefined',
  },
  {
    id: 'm32-scan-follows-symlink',
    claim: '条目枚举不再只收普通文件 —— 指向根外的链接条目被抄进索引（越权第三形读侧）',
    file: STORE,
    from: "        if (!dirent.isFile() || !dirent.name.endsWith('.md')) continue",
    to: "        if (!dirent.name.endsWith('.md')) continue",
  },
]

const SUITE = [
  join(ROOT, 'plugins/office-memory/distill.spec.ts'),
  join(ROOT, 'plugins/office-memory/arm.spec.ts'),
  join(ROOT, 'plugins/office-memory/store.spec.ts'),
  join(ROOT, 'plugins/office-memory/archive-order.spec.ts'),
]

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

const LOG = join(ROOT, '.spike/mutate-distill.log')
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
