// 等一条新的 pending 记录出现，再在它的同步窗口**之内**把批准 POST 进去。
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const dir = 'C:/Users/EDY/.dsh/storages/office_approval_ledger/requests'
const known = new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : [])
const token = process.env.OFFICE_APPROVAL_VERIFICATION_TOKEN ?? ''
const openId = process.env.SPIKE_APPROVER ?? 'ou_spike_approver'
const port = process.env.SPIKE_PORT ?? '3080'
const waitMs = Number(process.env.WAIT_MS ?? 10_000)

function log(o) { console.log(JSON.stringify({ now: Date.now(), ...o })) }

let record
const deadline = Date.now() + 120_000
while (record === undefined && Date.now() < deadline) {
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (known.has(f)) continue
    record = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).record
    break
  }
  if (record === undefined) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
}
if (record === undefined) { log({ error: 'no new record within 120s' }); process.exit(1) }
log({ stage: 'found', requestId: record.requestId, tool: record.toolName, status: record.status, remaining: record.windowEndsAt - Date.now() })

Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs)

const body = JSON.stringify({
  event: { operator: { open_id: openId }, action: { value: { requestId: record.requestId, decision: 'approve' }, tag: 'approve_button' } },
})
const timestamp = String(Date.now())
const nonce = 'spike-nonce-b'
const signature = createHash('sha1').update(`${timestamp}${nonce}${token}${body}`, 'utf8').digest('hex')
log({ stage: 'clicking', remainingBeforeClick: record.windowEndsAt - Date.now() })
const res = await fetch(`http://127.0.0.1:${port}/office/approval/callback`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-lark-request-timestamp': timestamp,
    'x-lark-request-nonce': nonce,
    'x-lark-signature': signature,
  },
  body,
})
log({ stage: 'responded', status: res.status, remainingAtClick: record.windowEndsAt - Date.now(), body: await res.text() })
