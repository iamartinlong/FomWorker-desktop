// spike 采样器：每秒记录台账域文件、卡片落盘、会话目录、outbox 的变化。
import fs from 'node:fs'
import path from 'node:path'

const home = 'C:/Users/EDY/.dsh'
const storages = path.join(home, 'storages')
const sessions = path.join(home, 'sessions')
const sink = 'F:/deepseek/deepseek harness/office-platform/.spike/cards.jsonl'
const outbox = 'C:/Users/EDY/workspace/outbox'
const out = process.env.TEMP + '/spike-sample.log'

function stamp() { return new Date().toISOString().slice(11, 23) }
function walk(dir, depth = 0, acc = []) {
  if (depth > 3 || !fs.existsSync(dir)) return acc
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p, depth + 1, acc)
    else acc.push({ p, size: st.size, mtime: st.mtimeMs })
  }
  return acc
}

const lines = []
for (let i = 0; i < 120; i++) {
  const parts = [stamp(), `t+${i}s`]
  const ledgerDir = path.join(storages, 'office_approval_ledger')
  parts.push('ledger=' + (fs.existsSync(ledgerDir) ? walk(ledgerDir).map(f => `${path.basename(f.p)}:${f.size}`).join(',') : 'ABSENT'))
  parts.push('sink=' + (fs.existsSync(sink) ? fs.statSync(sink).size : 'ABSENT'))
  parts.push('outbox=' + (fs.existsSync(outbox) ? fs.readdirSync(outbox).join(',') : 'ABSENT'))
  const sess = walk(sessions).filter(f => f.p.endsWith('.jsonl') && Date.now() - f.mtime < 20_000)
  parts.push('freshSessions=' + sess.map(f => `${path.basename(f.p)}:${f.size}`).join(','))
  lines.push(parts.join(' | '))
  fs.writeFileSync(out, lines.join('\n') + '\n')
  if (i < 119) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
}
console.log('sampling done')
