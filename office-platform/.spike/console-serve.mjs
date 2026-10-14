/**
 * 最小只读 L1 界面的真进程启动器 + 探针：
 * 叠 `office-catalog`（目录服务）+ `office-console`（host 路由 + 浏览器界面）起真 dsh web，
 * 探 `GET /office/catalog` 是否返回目录 JSON，并把带 token 的地址写到 `.spike/console.url` 供人打开。
 * 进程 detached、不随本脚本退出。停止：taskkill /PID <pid> /T /F（pid 在 `.spike/console.pid`）。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const KERNEL = String.raw`F:\deepseek\deepseek harness\deepseek-harness`
const SPIKE = String.raw`F:\deepseek\deepseek harness\office-platform\.spike`
const PLATFORM = String.raw`F:\deepseek\deepseek harness\office-platform`
const PORT = Number(process.argv[2] ?? 3204)
const LOG = path.join(SPIKE, 'console-boot.log')

const out = fs.openSync(LOG, 'w')
const child = spawn(
  process.execPath,
  ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web',
    '--patch', path.join(PLATFORM, 'office-catalog.patch.yml'),
    '--patch', path.join(PLATFORM, 'office-console.patch.yml'),
    '--no-open', '--port', String(PORT)],
  { cwd: KERNEL, stdio: ['ignore', out, out], detached: true },
)
child.unref()
fs.writeFileSync(path.join(SPIKE, 'console.pid'), `${String(child.pid)}\n`, 'utf8')
console.log(`spawned pid=${String(child.pid)} port=${String(PORT)}`)

const get = (pathname, headers = {}) => new Promise(resolve => {
  const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname, headers, timeout: 3000 }, res => {
    let body = ''
    res.setEncoding('utf8')
    res.on('data', c => { body += c })
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
  })
  req.on('error', e => resolve({ status: `ERR:${String(e.code)}`, headers: {}, body: '' }))
  req.on('timeout', () => { req.destroy(); resolve({ status: 'TIMEOUT', headers: {}, body: '' }) })
})

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
if (!url) { console.log(`URL 未出现，见 ${LOG}`); process.exit(1) }
fs.writeFileSync(path.join(SPIKE, 'console.url'), url + '\n', 'utf8')
console.log('URL 已写入 .spike/console.url')
console.log(url)

// 探只读目录路由（先不带 cookie；被拒再带 token 换来的 cookie）
let res = await get('/office/catalog')
if (res.status === 401) {
  const exchange = await get(new URL(url).pathname + new URL(url).search)
  const cookie = (exchange.headers['set-cookie']?.[0] ?? '').split(';')[0]
  res = await get('/office/catalog', cookie ? { cookie } : {})
}
console.log('GET /office/catalog status =', String(res.status))
try {
  const body = JSON.parse(res.body)
  console.log('version =', body.version, ' entries =', body.entries?.length, ' sample =',
    JSON.stringify(body.entries?.[0]?.id))
} catch {
  console.log('body(前 160) =', res.body.slice(0, 160))
}
