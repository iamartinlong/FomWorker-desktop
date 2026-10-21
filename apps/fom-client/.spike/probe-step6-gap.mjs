/**
 * ②s 的**空缺取证**：把「生产端把某个文件名改了」这四个变异体打在**没有 ⑨ 那组臂**的自证上，用实测回答
 * 「改名这件事原本到底静不静默」—— 这句是要写进验证记录的结论，不能靠推理。
 *
 * 「没有 ⑨」的形态不是编的：它是 ②s 之前磁盘上那份自证的真实形状，所以这里按行切掉 ⑨ 那一段（而不是另写一份
 * 旧文件当副本 —— 副本会随主文件漂）。临时副本落在 `.spike/.tmp-selftest-pre9.ts`，跑完删掉；生产端按字节还原。
 *
 * 纪律同 `mutate-step6-baseline.mjs`：一次只跑一份 harness、日志等进程退出后再读、变异期间不起产品。
 * 跑法：node "F:/deepseek/deepseek harness/apps/fom-client/.spike/probe-step6-gap.mjs"
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = 'F:/deepseek/deepseek harness/apps/fom-client'
const KERNEL = 'F:/deepseek/deepseek harness/deepseek-harness'
const TARGET = join(ROOT, '.spike/step6-baseline.mjs')
const SELFTEST = join(ROOT, '.spike/selftest-step6-baseline.ts')
const PRE9 = join(ROOT, '.spike/.tmp-selftest-pre9.ts')
const SEED = join(ROOT, '.spike/distill-workspace')
const LOG = join(ROOT, '.spike/probe-step6-gap.log')

const RENAMES = [
  { id: 'j-watermark-file-renamed', from: "path.join(memoryDir, 'daily/.watermark')", to: "path.join(memoryDir, 'daily/.distill-watermark')" },
  { id: 'k-armed-marker-file-renamed', from: "path.join(memoryDir, 'daily/.distill-armed')", to: "path.join(memoryDir, 'daily/.armed')" },
  { id: 'l-index-file-renamed', from: "path.join(memoryDir, 'MEMORY.md')", to: "path.join(memoryDir, 'MEMORY.markdown')" },
  { id: 'm-daily-dir-renamed', from: "fs.readdirSync(path.join(memoryDir, 'daily'))", to: "fs.readdirSync(path.join(memoryDir, 'dailies'))" },
]

function run(script) {
  let exit = 0
  let out = ''
  try {
    out = execFileSync(process.execPath, ['--import', 'tsx/esm', script, SEED], {
      cwd: KERNEL, encoding: 'utf8', stdio: 'pipe', timeout: 300_000,
    })
  } catch (error) {
    exit = typeof error.status === 'number' ? error.status : -1
    out = `${String(error.stdout ?? '')}${String(error.stderr ?? '')}`
  }
  const plain = out.replace(/\u001B\[[0-9;]*m/g, '')
  return { exit, failed: [...new Set([...plain.matchAll(/✗ (.+)/g)].map(match => match[1].trim()))] }
}

const lines = []
const flush = line => {
  lines.push(line)
  appendFileSync(LOG, `${line}\n`, 'utf8')
  console.log(line)
}

writeFileSync(LOG, '', 'utf8')
const source = await readFile(SELFTEST, 'utf8')
const start = source.indexOf('// ⑨ ')
const end = source.indexOf('works.forEach(')
if (start < 0 || end < 0 || end < start) throw new Error('切不出「②s 之前」那份形态：⑨ 段落或清理行没找到')
writeFileSync(PRE9, `${source.slice(0, start)}${source.slice(end)}`, 'utf8')

const cleanPre9 = run(PRE9)
flush(`baseline（无 ⑨、无变异）: ${cleanPre9.exit === 0 && cleanPre9.failed.length === 0 ? 'green' : `RED exit=${String(cleanPre9.exit)}`}`)

try {
  const original = await readFile(TARGET, 'utf8')
  for (const mutant of RENAMES) {
    if (!original.includes(mutant.from)) {
      flush(`${mutant.id}: SKIPPED（锚点没找到）`)
      continue
    }
    await writeFile(TARGET, original.replace(mutant.from, mutant.to), 'utf8')
    const pre9 = run(PRE9)
    await writeFile(TARGET, original, 'utf8')
    if (await readFile(TARGET, 'utf8') !== original) throw new Error(`${mutant.id}: 还原失败`)
    flush(`${mutant.id}: 无 ⑨ 时 ${pre9.failed.length === 0 ? '★ 静默（0 条红、退出码 ' + String(pre9.exit) + '）' : `抓住 ${String(pre9.failed.length)} 条红`}`)
    for (const name of pre9.failed.slice(0, 4)) appendFileSync(LOG, `    · ${name}\n`, 'utf8')
  }
  if (await readFile(TARGET, 'utf8') !== original) throw new Error('生产端未还原')
} finally {
  if (existsSync(PRE9)) rmSync(PRE9)
}

const silent = lines.filter(line => line.includes('★ 静默')).length
flush(`结论：${String(silent)}/${String(RENAMES.length)} 个改名在 ②s 之前完全静默（其余那几个只被 ①/⑥ 那组**间接**撞到，红例点名的是「有一条 fail」而不是「文件名错了」）；⑨ 之后四个都由 mutate-step6-baseline.mjs 逐个钉死`)
