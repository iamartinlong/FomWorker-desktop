/**
 * D 真进程验证：在真 dsh web 上验证「认证写路由」`POST /api/office/console/action`。
 * 期望：owner 非高危→200；member 装插件→403；owner 未批→202；owner 已批→200。
 * 起进程（叠 office-catalog/authz/console）→ 换 token cookie → POST 四例 → 打印 → 结束进程。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const KERNEL = String.raw`F:\deepseek\deepseek harness\deepseek-harness`
const P = String.raw`F:\deepseek\deepseek harness\apps\fom-client`
const SPIKE = String.raw`F:\deepseek\deepseek harness\apps\fom-client\.spike`
const PORT = Number(process.argv[2] ?? 3207)
const LOG = path.join(SPIKE, 'write-route-boot.log')

const out = fs.openSync(LOG, 'w')
const child = spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web',
  '--patch', path.join(P, 'office-catalog.patch.yml'),
  '--patch', path.join(P, 'office-authz.patch.yml'),
  '--patch', path.join(P, 'office-console.patch.yml'),
  '--no-open', '--port', String(PORT)], { cwd: KERNEL, stdio: ['ignore', out, out], detached: true })
child.unref()
console.log('spawned pid', child.pid, 'port', PORT)

const req = (method, pathname, headers = {}, body) => new Promise(resolve => {
  const r = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method, headers, timeout: 5000 }, res => {
    let b = ''
    res.setEncoding('utf8')
    res.on('data', c => { b += c })
    res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }))
  })
  r.on('error', e => resolve({ status: `ERR:${String(e.code)}`, body: '' }))
  r.on('timeout', () => { r.destroy(); resolve({ status: 'TIMEOUT', body: '' }) })
  if (body !== undefined) r.write(body)
  r.end()
})

const ANSI = new RegExp('\u001B\\[[0-9;]*m', 'g')
const deadline = Date.now() + 150_000
let url
while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 3000))
  let text = ''
  try { text = fs.readFileSync(LOG, 'utf8').replace(ANSI, '') } catch { continue }
  const m = text.match(new RegExp(`http://127\\.0\\.0\\.1:${String(PORT)}/\\S+`))
  if (m) { url = m[0].replace(/[.,)]+$/, ''); break }
}
if (!url) { console.log('URL 未出现，见', LOG); process.exit(1) }
fs.writeFileSync(path.join(SPIKE, 'write-route.url'), url + '\n', 'utf8')
console.log('ready, url 已写 .spike/write-route.url')

const exchange = await req('GET', new URL(url).pathname + new URL(url).search)
const cookie = (exchange.headers['set-cookie']?.[0] ?? '').split(';')[0]
console.log('token exchange status', String(exchange.status), 'cookie?', Boolean(cookie))

const origin = `http://127.0.0.1:${String(PORT)}`
const headers = { 'content-type': 'application/json', origin, host: `127.0.0.1:${String(PORT)}`, ...(cookie ? { cookie } : {}) }
const post = (body) => req('POST', '/api/office/console/action', headers, JSON.stringify(body))

const cases = [
  ['capability.toggle（非高危）', { action: 'capability.toggle', payload: { id: 'skill:meeting-minutes', on: false } }, 200],
  ['bundle.install（高危·未批）', { action: 'bundle.install', payload: { spec: '@x/y' } }, 202],
]
for (const [name, body, expect] of cases) {
  const res = await post(body)
  const ok = res.status === expect ? 'OK ' : 'FAIL'
  console.log(`${ok} ${name}: status=${String(res.status)} (期望 ${expect}) body=${res.body.slice(0, 80)}`)
}

// 服务端审批流：install → 202(approvalId) → decide grant → 带 approvalId 重试 → 200 → 重放 → 202
const req1 = await post({ action: 'bundle.install', payload: { spec: '@approved/pkg' } })
const id1 = JSON.parse(req1.body).approvalId
console.log('install → status', String(req1.status), 'approvalId =', String(id1))
const grant = await post({ action: 'approval.decide', payload: { id: id1, decision: 'grant' } })
console.log('approval.decide(grant) → status', String(grant.status), grant.body.slice(0, 90))
const req2 = await post({ action: 'bundle.install', payload: { spec: '@approved/pkg' }, approvalId: id1 })
console.log('install +approvalId → status', String(req2.status), '(期望 200)', req2.body.slice(0, 100))
const req3 = await post({ action: 'bundle.install', payload: { spec: '@approved/pkg' }, approvalId: id1 })
console.log('install 重放同一 approvalId → status', String(req3.status), '(期望 202 已消费)')

// 真实 executor + 状态读：toggle 后启用态改变
const state1 = await req('GET', '/office/console/state', {})
console.log('state(before) =', state1.body.slice(0, 140))
const toggle = await post({ role: 'owner', action: 'capability.toggle', approved: false, payload: { id: 'connector:feishu', on: true } })
console.log('toggle connector:feishu on =', String(toggle.status), toggle.body.slice(0, 100))
const state2 = await req('GET', '/office/console/state', {})
console.log('state(after) =', state2.body.slice(0, 200))

try { child.kill('SIGTERM') } catch { /* gone */ }
console.log('done')
process.exit(0)
