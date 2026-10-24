/**
 * `distill-home.mjs`（F-6A 的独立 DSH_HOME 构建件）的变异检验：把它的每条口径挨个改坏，
 * 看 `selftest-distill-home.mjs` 是否变红。绿 = 那条口径没被钉住。
 *
 * 纪律同 `mutate-a2.mjs`：一次一份、逐条快照还原、判据＝自证输出里有具名 `✗`（退出码非 0 但零 `✗` 只能算「跑不起来」）。
 * 跑完逐条 `diff` 还原。
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = 'F:/deepseek/deepseek harness/apps/fom-client'
const PRODUCT = join(ROOT, '.spike/distill-home.mjs')
const SELFTEST = join(ROOT, '.spike/selftest-distill-home.mjs')

const MUTANTS = [
  {
    id: 'a-isolated-name-broken',
    claim: '把必须独立的 `storages` 名字改掉 ⇒ 源 storages 也被 junction 进来，自证「storages 是真目录 / 独立且空 / 源文件没被带进来」必须红',
    from: "const ISOLATED = 'storages'",
    to: "const ISOLATED = '__none__'",
  },
  {
    id: 'b-file-copied-not-linked',
    claim: '文件改成 copy 而不是 hardlink（凭据被复制一份）⇒ 自证「nlink≥2（hardlink）」必须红',
    from: '      fs.linkSync(from, to)',
    to: '      fs.copyFileSync(from, to)',
  },
  {
    id: 'c-isolated-not-reported',
    claim: '不再把「storages 独立」写进返回清单 ⇒ 自证「返回值里点名了 storage 的独立」必须红（观测当天靠这条清单判断隔离发生过）',
    from: '  linked.push(`dir  ${ISOLATED}（独立、空）`)',
    to: '  // 变异体 c：不再点名 storages 的独立',
  },
]

function runSelftest() {
  let exit = 0
  let out = ''
  try {
    out = execFileSync(process.execPath, [SELFTEST], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 60_000 })
  } catch (error) {
    exit = typeof error.status === 'number' ? error.status : -1
    out = `${String(error.stdout ?? '')}${String(error.stderr ?? '')}`
  }
  const plain = out.replace(/\u001B\[[0-9;]*m/g, '')
  const failed = [...new Set([...plain.matchAll(/✗[^\n]*/g)].map(line => line[0].replace(/^✗\s*/, '').trim()))]
  return { caught: exit !== 0 && failed.length > 0, failed, exit }
}

const LOG = join(ROOT, '.spike/mutate-distill-home.log')
const lines = []
const flush = (line) => { lines.push(line); appendFileSync(LOG, `${line}\n`, 'utf8'); console.log(line) }

writeFileSync(LOG, '', 'utf8')
const baseline = runSelftest()
flush(`baseline: ${baseline.exit !== 0 ? `RED (exit=${String(baseline.exit)}) —— 变异前就红，结论不可信` : 'green'}`)
if (baseline.exit !== 0) process.exit(1)

for (const mutant of MUTANTS) {
  const original = await readFile(PRODUCT, 'utf8')
  if (!original.includes(mutant.from)) { flush(`${mutant.id}: SKIPPED（锚点没找到）`); continue }
  await writeFile(PRODUCT, original.replace(mutant.from, mutant.to), 'utf8')
  const result = runSelftest()
  await writeFile(PRODUCT, original, 'utf8')
  if (await readFile(PRODUCT, 'utf8') !== original) throw new Error(`${mutant.id}: 还原失败`)
  flush(`${mutant.id}: ${result.caught ? '抓住' : '活下来'} —— ${String(result.failed.length)} 例红（exit=${String(result.exit)}）— ${mutant.claim}`)
  for (const name of result.failed.slice(0, 6)) appendFileSync(LOG, `    · ${name}\n`, 'utf8')
}

const survivors = lines.filter(line => line.includes('活下来') || line.includes('SKIPPED'))
flush(`结论：${String(MUTANTS.length - survivors.length)}/${String(MUTANTS.length)} 个变异被抓住`)
