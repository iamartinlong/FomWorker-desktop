/**
 * 变异检验驱动（可复用）。
 *
 * 用法：`node .spike/mutate.mjs --target <src.ts> --spec <spec.ts> --cases <cases.json>`
 * `cases.json` 是 `[{ name, from, to }]`。每条改坏跑一次目标 spec，**必须红**才算被抓住。
 *
 * 三条落地约束（第 6 步逐条跑出来的形状）：vitest 失败时非零退出且 stdout 带 ANSI，
 * 不 catch 就把输出丢了；`from` 出现 0 次或 >1 次说明这条变异没真落到代码上，要单独报；
 * 改完必须还原，所以整份原文先在内存里留着。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g')

function arg(name) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const target = arg('target')
const spec = arg('spec')
const casesPath = arg('cases')
if (!target || !spec || !casesPath) {
  console.error('usage: node .spike/mutate.mjs --target <src.ts> --spec <spec.ts> --cases <cases.json>')
  process.exit(2)
}

const cases = JSON.parse(readFileSync(casesPath, 'utf8'))
const original = readFileSync(target, 'utf8')

function count(haystack, needle) {
  let n = 0
  let i = haystack.indexOf(needle)
  while (i >= 0) {
    n += 1
    i = haystack.indexOf(needle, i + needle.length)
  }
  return n
}

function runSpec() {
  const proc = spawnSync(
    process.execPath,
    ['node_modules/vitest/vitest.mjs', 'run', spec],
    { encoding: 'utf8', shell: false },
  )
  const out = ((proc.stdout ?? '') + (proc.stderr ?? '')).replace(ANSI, '')
  const failed = proc.status !== 0
  const summary = out
    .split('\n')
    .filter((l) => /Tests\s+\d|failed|Cannot find|TypeError|AssertionError/.test(l))
    .slice(0, 4)
    .join(' | ')
    .trim()
  return { failed, summary }
}

let caught = 0
let survived = 0
let broken = 0

try {
  for (const c of cases) {
    const hits = count(original, c.from)
    if (hits !== 1) {
      broken += 1
      console.log(`SETUP-FAIL  ${c.name}  (anchor appears ${hits}x)`)
      continue
    }
    writeFileSync(target, original.replace(c.from, c.to))
    const { failed, summary } = runSpec()
    if (failed) {
      caught += 1
      console.log(`CAUGHT      ${c.name}`)
    } else {
      survived += 1
      console.log(`SURVIVED    ${c.name}  ->  ${summary}`)
    }
  }
} finally {
  writeFileSync(target, original)
}

const baseline = runSpec()
console.log('')
console.log(`total=${cases.length} caught=${caught} survived=${survived} setup-fail=${broken}`)
console.log(`restored baseline: ${baseline.failed ? 'RED (restore broken!)' : 'green'}`)
process.exit(survived === 0 && broken === 0 && !baseline.failed ? 0 : 1)
