/**
 * 常驻启动器：起真 dsh web（只挂外挂 UI bundle），把带 token 的地址写到
 * `.spike/ui-console.url` 供人在浏览器里打开查看。进程 detached、不随本脚本退出。
 * 停止：taskkill /PID <pid> /T /F（pid 写在 .spike/ui-console.pid）。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const KERNEL = String.raw`F:\deepseek\deepseek harness\deepseek-harness`
const SPIKE = String.raw`F:\deepseek\deepseek harness\apps\fom-client\.spike`
const PORT = Number(process.argv[2] ?? 3203)
const LOG = path.join(SPIKE, 'ui-console-boot.log')

const out = fs.openSync(LOG, 'w')
const child = spawn(
  process.execPath,
  ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web',
    '--patch', path.join(SPIKE, 'ui-console-spike.mount.yml'),
    '--no-open', '--port', String(PORT)],
  { cwd: KERNEL, stdio: ['ignore', out, out], detached: true },
)
child.unref()
fs.writeFileSync(path.join(SPIKE, 'ui-console.pid'), `${String(child.pid)}\n`, 'utf8')
console.log(`spawned pid=${String(child.pid)} port=${String(PORT)} (detached, keeps running)`)

const ANSI = new RegExp('\u001B\\[[0-9;]*m', 'g')
const deadline = Date.now() + 180_000
let url
while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 3000))
  let text = ''
  try { text = fs.readFileSync(LOG, 'utf8').replace(ANSI, '') } catch { continue }
  const m = text.match(new RegExp(`http://127\\.0\\.0\\.1:${String(PORT)}/\\S+`))
  if (m) { url = m[0].replace(/[.,)]+$/, ''); break }
}
if (!url) {
  console.log(`URL 未出现，见 ${LOG}`)
  process.exit(1)
}
fs.writeFileSync(path.join(SPIKE, 'ui-console.url'), url + '\n', 'utf8')
console.log('URL 已写入 .spike/ui-console.url')
console.log(url)
