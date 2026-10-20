// 等一条新的 pending 记录出现（新的 requestId），把它的窗口终点打印出来。
import fs from 'node:fs'
import path from 'node:path'

const dir = 'C:/Users/EDY/.dsh/storages/office_approval_ledger/requests'
const known = new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : [])
const deadline = Date.now() + 90_000
while (Date.now() < deadline) {
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (known.has(f)) continue
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).record
    console.log(JSON.stringify({
      requestId: r.requestId, tool: r.toolName, status: r.status,
      windowEndsAt: r.windowEndsAt, remaining: r.windowEndsAt - Date.now(), now: Date.now(),
    }))
    process.exit(0)
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
}
console.log(JSON.stringify({ error: 'no new record within 90s' }))
process.exit(1)
