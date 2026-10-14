/**
 * `office-skills` 技能提供者的变异检验：把每条口径改坏，看 `index.spec.ts` 是否变红。
 * 纪律同 `mutate-feishu.mjs`。
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = 'F:/deepseek/deepseek harness/office-platform'
const PRODUCT = join(ROOT, 'plugins/office-skills/index.ts')

const MUTANTS = [
  {
    id: 'a-relative-assetroot-accepted',
    claim: '去掉「assetRoot 必须绝对路径」这道守卫 ⇒ 相对路径的用例必须红',
    from: "  if (!isAbsolute(assetRoot)) throw new Error('office-skills: assetRoot 必须是绝对路径')",
    to: '  // 变异体 a：不再校验绝对路径',
  },
  {
    id: 'b-missing-skill-md-accepted',
    claim: '去掉挂载时「SKILL.md 在场」校验 ⇒ 缺文件不抛、静默装半个技能，缺文件用例必须红',
    from: '    readFileSync(path, \'utf8\')',
    to: '    void path',
  },
  {
    id: 'c-frontmatter-not-stripped',
    claim: 'skillBody 不剥 frontmatter（正文带上 `---`）⇒ 剥壳用例必须红',
    from: "  const match = /^---\\r?\\n[\\s\\S]*?\\r?\\n---(?:\\r?\\n|$)/u.exec(raw)\n  return (match === null ? raw : raw.slice(match[0].length)).trim()",
    to: '  return raw.trim()',
  },
]

const SUITE = [join(ROOT, 'plugins/office-skills/index.spec.ts')]

function runSuite() {
  let exit = 0
  let out = ''
  try {
    out = execFileSync(process.execPath, [
      join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', '--no-file-parallelism', ...SUITE,
    ], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 180_000 })
  } catch (error) {
    exit = typeof error.status === 'number' ? error.status : -1
    out = `${String(error.stdout ?? '')}${String(error.stderr ?? '')}`
  }
  const plain = out.replace(/\u001B\[[0-9;]*m/g, '')
  const failed = [...new Set([...plain.matchAll(/×[^\n]*/g)].map(line => line[0].replace(/^×\s*/, '').trim()))]
  return { caught: exit !== 0 && failed.length > 0, failed, exit }
}

const LOG = join(ROOT, '.spike/mutate-skills.log')
const lines = []
const flush = (line) => { lines.push(line); appendFileSync(LOG, `${line}\n`, 'utf8'); console.log(line) }

writeFileSync(LOG, '', 'utf8')
const baseline = runSuite()
flush(`baseline: ${baseline.exit !== 0 ? `RED (exit=${String(baseline.exit)}) —— 变异前就红，结论不可信` : 'green'}`)
if (baseline.exit !== 0) process.exit(1)

for (const mutant of MUTANTS) {
  const original = await readFile(PRODUCT, 'utf8')
  if (!original.includes(mutant.from)) { flush(`${mutant.id}: SKIPPED（锚点没找到）`); continue }
  await writeFile(PRODUCT, original.replace(mutant.from, mutant.to), 'utf8')
  const result = runSuite()
  await writeFile(PRODUCT, original, 'utf8')
  if (await readFile(PRODUCT, 'utf8') !== original) throw new Error(`${mutant.id}: 还原失败`)
  flush(`${mutant.id}: ${result.caught ? '抓住' : '活下来'} —— ${String(result.failed.length)} 例红（exit=${String(result.exit)}）— ${mutant.claim}`)
}

const survivors = lines.filter(line => line.includes('活下来') || line.includes('SKIPPED'))
flush(`结论：${String(MUTANTS.length - survivors.length)}/${String(MUTANTS.length)} 个变异被抓住`)
