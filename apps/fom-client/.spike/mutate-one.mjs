/** 单条变异的手动复现：打印完整 vitest 输出，供人读失败原因（mutate.mjs 只给摘要）。 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g')
const [target, casesFile, spec, index] = process.argv.slice(2)
const c = JSON.parse(readFileSync(casesFile, 'utf8'))[Number(index)]
const original = readFileSync(target, 'utf8')
const backup = target + '.mutation-bak'
renameSync(target, backup)
try {
  writeFileSync(target, original.replace(c.from, c.to))
  console.log(`applied: ${c.name}`)
  const proc = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', spec], { encoding: 'utf8' })
  console.log(((proc.stdout ?? '') + (proc.stderr ?? '')).replace(ANSI, ''))
  console.log(`exit=${proc.status}`)
} finally {
  renameSync(backup, target)
  console.log('restored')
}
