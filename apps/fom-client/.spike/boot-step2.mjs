/**
 * 记忆层第 2 步的真进程观察启动器。
 *
 * 与第 7、8 步那两份启动脚本同构，只多了 `office-memory.spike.patch.yml` 一行；
 * 就绪判据仍用 `GET /office/approval/callback → 405`（路由挂上且只收 POST），
 * 不用 `/` —— 它在启动过程中先答 404 再答 401。
 *
 * 带 token 的 URL 只写进 `.spike/step2.url`，不回显。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const KERNEL = String.raw`F:\deepseek\deepseek harness\deepseek-harness`
const SPIKE = String.raw`F:\deepseek\deepseek harness\apps\fom-client`
const PORT = Number(process.argv[2] ?? 3083)
const LOG = path.join(SPIKE, '.spike/step2-boot.log')
const memoryRoot = path.join(SPIKE, '.spike/memory-spike')

// 观察产物每次从干净目录开始：判据里有「文件真落盘」，残留会让第二次观察看起来像第一次的功劳。
fs.rmSync(memoryRoot, { recursive: true, force: true })
fs.mkdirSync(memoryRoot, { recursive: true })

const out = fs.openSync(LOG, 'w')
const child = spawn(
  process.execPath,
  ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web',
    '--patch', path.join(SPIKE, 'office-approval.patch.yml'),
    '--patch', path.join(SPIKE, 'office-memory.spike.patch.yml'),
    '--patch', './office.patch.yml',
    '--patch', 'apps/web/tests/pin-browse-picker.overlay.yml',
    '--no-open', '--port', String(PORT)],
  { cwd: KERNEL, stdio: ['ignore', out, out], detached: true },
)
child.unref()
fs.writeFileSync(path.join(SPIKE, '.spike/step2.pid'), `${String(child.pid)}\n`, 'utf8')

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
fs.writeFileSync(path.join(SPIKE, '.spike/step2.url'), `${urls[urls.length - 1].replace(/[.,)]+$/, '')}\n`, 'utf8')
console.log(`ready: 405 on :${String(PORT)}；pid=${String(child.pid)}；URL 已写入 .spike/step2.url（含 token，未回显）`)
