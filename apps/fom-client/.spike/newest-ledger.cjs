// 最近若干条审批台账记录的字段转储（按文件 mtime 倒序）。只读显式路径，不 grep .dsh。
const fs = require('fs')
const path = require('path')
const dir = 'C:/Users/EDY/.dsh/storages/office_approval_ledger/requests'
const N = Number(process.argv[2] ?? 3)
const files = fs.readdirSync(dir).map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m).slice(0, N)
for (const { f, m } of files) {
  const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).record
  console.log('###', new Date(m).toISOString(), f)
  console.log(JSON.stringify({
    requestId: r.requestId, toolName: r.toolName, riskLevel: r.riskLevel, status: r.status,
    actionSummary: r.actionSummary, sessionId: r.sessionId, callId: r.callId,
    sandbox_permissions: r.toolArgs?.sandbox_permissions, hasJustification: typeof r.toolArgs?.justification === 'string' && r.toolArgs.justification.length > 0,
    windowEndsAt: new Date(r.windowEndsAt).toISOString(), decidedBy: r.decidedBy ?? '-',
  }, null, 1))
}
