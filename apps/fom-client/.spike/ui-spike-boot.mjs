/**
 * M2.0 验证探针：只挂「外挂 UI bundle」，起真 dsh web，验证 client-modules
 * 是否发现了它（条目 id 出现在注入的 window.__DSH_BOOT__ 图里）并服务它的 client.js。
 *
 * 就绪判据用 `/`（启动过程中先 404 再 401）；token 取日志里的带 token URL。
 * 端口取空闲值，避免踩到残留的 dsh 进程。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const KERNEL = String.raw`F:\deepseek\deepseek harness\deepseek-harness`
const SPIKE = String.raw`F:\deepseek\deepseek harness\apps\fom-client\.spike`
const PORT = Number(process.argv[2] ?? 3199)
const ROW_ID = 'office-console-spike'
const RECORD_ID = '@office/console-spike'
const LOG = path.join(SPIKE, 'ui-spike-boot.log')

const out = fs.openSync(LOG, 'w')
const child = spawn(
  process.execPath,
  ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web',
    '--patch', path.join(SPIKE, 'ui-console-spike.mount.yml'),
    '--no-open', '--port', String(PORT)],
  { cwd: KERNEL, stdio: ['ignore', out, out], detached: true },
)
child.unref()
console.log(`spawned pid=${String(child.pid)} port=${String(PORT)}`)

const get = (pathname, headers = {}) => new Promise(resolve => {
  const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname, headers, timeout: 3000 }, res => {
    let body = ''
    res.setEncoding('utf8')
    res.on('data', c => { body += c })
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
  })
  req.on('error', error => resolve({ status: `ERR:${String(error.code)}`, headers: {}, body: '' }))
  req.on('timeout', () => { req.destroy(); resolve({ status: 'TIMEOUT', headers: {}, body: '' }) })
})

const deadline = Date.now() + 300_000
let probe
while (Date.now() < deadline) {
  probe = await get('/')
  if (probe.status === 401 || probe.status === 200) break
  await new Promise(r => setTimeout(r, 4000))
}
console.log(`readiness status = ${String(probe.status)}`)
if (probe.status !== 401 && probe.status !== 200) {
  console.log(`NOT ready，见 ${LOG}`)
  try { child.kill('SIGTERM') } catch { /* gone */ }
  process.exit(1)
}

const ANSI = new RegExp('\u001B\\[[0-9;]*m', 'g')
let urls = []
const urlDeadline = Date.now() + 180_000
while (Date.now() < urlDeadline) {
  const text = fs.readFileSync(LOG, 'utf8').replace(ANSI, '')
  urls = text.match(new RegExp(`http://127\\.0\\.0\\.1:${String(PORT)}/\\S+`, 'g')) ?? []
  if (urls.length > 0) break
  await new Promise(r => setTimeout(r, 3000))
}
console.log('token URL found =', urls.length > 0)
let cookie
if (urls.length > 0) {
  const tokenUrl = urls[urls.length - 1].replace(/[.,)]+$/, '')
  fs.writeFileSync(path.join(SPIKE, 'ui-spike.url'), tokenUrl + '\n', 'utf8')
  const exchange = await get(new URL(tokenUrl).pathname + new URL(tokenUrl).search)
  const sc = exchange.headers['set-cookie']
  if (sc && sc[0]) cookie = sc[0].split(';')[0]
  console.log('token exchange status =', String(exchange.status), ' cookie =', Boolean(cookie))
}

const headers = cookie ? { cookie } : {}
const index = await get('/', headers)
console.log('index status =', String(index.status), ' len =', index.body.length)
const hasRow = index.body.includes(ROW_ID)
console.log('index contains row id', ROW_ID, '=', hasRow)
console.log('index contains pkg id @office/console-spike =', index.body.includes(RECORD_ID))
{
  const i = index.body.indexOf(RECORD_ID)
  if (i >= 0) console.log('snippet =', JSON.stringify(index.body.slice(Math.max(0, i - 240), i + 80)))
}

const bundle = await get(`/plugins/??${RECORD_ID}/client.js&rev=000000000000`, headers)
console.log('bundle route status =', String(bundle.status), ' bodyHasModuleLoader =', bundle.body.includes('__ModuleLoader__'), ' len =', bundle.body.length)

const combos = [...new Set(index.body.match(/plugins\/\?\?[^"'\s<>]+/g) ?? [])]
let served = false
for (const combo of combos) {
  const r = await get('/' + combo, headers)
  if (r.body.includes('Office Console Spike') || r.body.includes(RECORD_ID)) {
    served = true
    console.log('SERVED our client.js via combo:', combo.slice(0, 70), ' status', String(r.status), ' len', r.body.length)
    break
  }
}
console.log('client.js served =', served)

try { child.kill('SIGTERM') } catch { /* gone */ }
console.log('done')
process.exit(0)
