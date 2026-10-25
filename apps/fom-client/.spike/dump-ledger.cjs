const fs = require('fs')
const dir = 'C:/Users/EDY/.dsh/storages/office_approval_ledger'
const iso = n => (n == null ? '-' : new Date(n).toISOString().replace('T', ' ').slice(5, 19) + 'Z')
for (const f of fs.readdirSync(`${dir}/requests`).sort()) {
  const r = JSON.parse(fs.readFileSync(`${dir}/requests/${f}`, 'utf8')).record
  const inWin = r.decidedAt == null ? '-' : r.decidedAt <= r.windowEndsAt ? '窗口内' : `超窗 +${Math.round((r.decidedAt - r.windowEndsAt) / 1000)}s`
  const target = (r.actionSummary.match(/[A-Za-z]:\\\\[^\\\\]*|[\w.-]+\.(txt|md|ps1)/g) || ['-']).join(',')
  console.log([r.requestId.slice(0, 8), r.toolName.padEnd(4), target.padEnd(30), r.status.padEnd(8), 'ask=' + iso(r.askedAt), 'dec=' + iso(r.decidedAt), inWin.padEnd(12), r.decidedBy ?? '-'].join(' | '))
}
