/**
 * 记忆层第 3 步（注入 + 三条守卫）的真进程观察启动器。
 *
 * 与 `boot-step2.mjs` 同构，三处不同：
 *   1. 叠的是 `office-memory.spike3.patch.yml`，它的 memoryRoot 已由 `.spike/seed-memory.mjs` 种好
 *      （索引 3 条 + 一行越界凭据）—— 这一步**不 rm 记忆目录**，种子必须原样在场，
 *      rm 了就等于把观察对象（磁盘 MEMORY.md）删掉了。
 *   2. 用空端口 3084（3083 那份是第 2 步的现场，可能还挂着；不抢占，另起一个）。
 *   3. 带 token 的 URL 写进 `.spike/step3.url`，不回显。
 *
 * 就绪判据仍是 `GET /office/approval/callback → 405`（路由挂上且只收 POST），不用 `/`
 * —— 它在启动过程中先答 404 再答 401。冷启动约 100s，deadline 给到 300s。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const KERNEL = String.raw`F:\deepseek\deepseek harness\deepseek-harness`
const SPIKE = String.raw`F:\deepseek\deepseek harness\office-platform`
const PORT = Number(process.argv[2] ?? 3084)
const LOG = path.join(SPIKE, '.spike/step3-boot.log')

const out = fs.openSync(LOG, 'w')
const child = spawn(
  process.execPath,
  ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web',
    '--patch', path.join(SPIKE, 'office-approval.patch.yml'),
    '--patch', path.join(SPIKE, 'office-memory.spike3.patch.yml'),
    '--patch', './office.patch.yml',
    '--patch', 'apps/web/tests/pin-browse-picker.overlay.yml',
    '--no-open', '--port', String(PORT)],
  { cwd: KERNEL, stdio: ['ignore', out, out], detached: true },
)
child.unref()
fs.writeFileSync(path.join(SPIKE, '.spike/step3.pid'), `${String(child.pid)}\n`, 'utf8')

const probe = () => new Promise(resolve => {
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/office/approval/callback', timeout: 2000 }, res => {
    res.resume()
    resolve(res.statusCode)
  })
  req.on('error', error => resolve(`ERR:${String(error.code)}`))
  req.on('timeout', () => { req.destroy(); resolve('TIMEOUT') })
})

const deadline = Date.now() + 300_000
let status = null
while (Date.now() < deadline) {
  status = await probe()
  if (status === 405) break
  await new Promise(r => setTimeout(r, 4000))
}
if (status !== 405) {
  console.log(`NOT ready: status=${String(status)}，见 ${LOG}`)
  child.kill('SIGTERM')
  process.exit(1)
}

const ANSI = new RegExp('\u001B\\[[0-9;]*m', 'g')
const text = fs.readFileSync(LOG, 'utf8').replace(ANSI, '')
const urls = text.match(new RegExp(`http://127\\.0\\.0\\.1:${String(PORT)}/\\S+`, 'g')) ?? []
if (urls.length === 0) {
  console.log(`ready(405) 但日志里还没有带 token 的 URL pid=${String(child.pid)}`)
  process.exit(1)
}
fs.writeFileSync(path.join(SPIKE, '.spike/step3.url'), `${urls[urls.length - 1].replace(/[.,)]+$/, '')}\n`, 'utf8')
console.log(`ready: 405 on :${String(PORT)}；pid=${String(child.pid)}；URL 已写入 .spike/step3.url（含 token，未回显）`)
