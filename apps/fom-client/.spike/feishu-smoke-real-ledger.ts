/**
 * 真台账 + 真渠道的最小复现（§8 第 8 步的排障臂）。
 *
 * `feishu-smoke-send.ts` 用的是内存桩台账，它绿了；产品进程里同一份渠道代码却**没发出卡**。
 * 两者的唯一差别就是台账，所以这里把 `test-harness` 的真 json 台账接进来跑同一条 `send`，
 * 并把错误原样打出来 —— 渠道的 per-recipient 循环会把失败吞成交棒，这里不吞。
 *
 * 用法（在 `apps/fom-client/` 下）：
 *   node --import ../deepseek-harness/node_modules/tsx/dist/loader.mjs .spike/feishu-smoke-real-ledger.ts [open_id]
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createTenantTokenSource, installFeishuApprovalChannel } from '../plugins/office-approval/feishu-channel.ts'
import { createHttpFeishuTransport } from '../plugins/office-approval/feishu-transport-http.ts'
import { argsDigest, type ApprovalRequestRecord } from '../plugins/office-approval/ledger.ts'
import { boot } from '../plugins/office-approval/test-harness.ts'

const here = dirname(fileURLToPath(import.meta.url))

function readEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq > 0) out[t.slice(0, eq)] = t.slice(eq + 1)
  }
  return out
}

const env = readEnv(resolve(here, '../.secrets/feishu-dev.env'))
const openId = process.argv[2] ?? 'ou_e66ad5f9e6604d4184d17215b1c2adc7'

const harness = await boot({})
const record: ApprovalRequestRecord = {
  requestId: `real-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}`,
  sessionId: harness.sessionId ?? SessionId('session-real-smoke'),
  callId: 'call_real',
  rootCallId: 'call_real',
  tenantId: 'tenant-local',
  toolName: 'write',
  riskLevel: 'L2',
  actionSummary: '真台账冒烟：写入 outbox/real.txt',
  toolArgs: { file_path: 'C:\\Users\\EDY\\workspace\\outbox\\real.txt', content: 'x' },
  displayReason: '这个动作会对外可见，需要你批准。',
  status: 'pending',
  askedAt: Date.now(),
  windowEndsAt: Date.now() + 240_000,
  expiresAt: Date.now() + 86_400_000,
  decidedBy: null,
  decidedAt: null,
}
await harness.ledger.create(record)

const transport = createHttpFeishuTransport({ timeoutMs: 10_000 })
const failures: string[] = []
const channel = installFeishuApprovalChannel({
  transport,
  tokens: createTenantTokenSource(transport, env.FEISHU_APP_ID ?? '', env.FEISHU_APP_SECRET ?? ''),
  ledger: harness.ledger,
  recipientsOf: () => [openId],
  initiatorOf: () => openId,
  onFailure: (error, info) => {
    failures.push(`${info.path}: ${String(error)}`)
  },
})

console.log(`sessionId 落点：${String(record.sessionId)}`)
console.log(`argsDigest 前 12：${argsDigest(record.toolArgs as Record<string, unknown>).slice(0, 12)}`)
try {
  const card = await channel.send(record, new AbortController().signal)
  console.log(`send ok -> ${JSON.stringify(card)}`)
  const handle = harness.ledger.cardHandle(record.requestId)
  console.log(`台账句柄：${JSON.stringify(handle)}`)
} catch (error) {
  console.log(`send FAILED：${String(error)}`)
  console.log(`cause：${String((error as { cause?: unknown }).cause ?? '(无)')}`)
}
console.log(`渠道内失败上报：${JSON.stringify(failures)}`)
console.log(`digest 复查（应等于上面那 12 位）：${argsDigest(record.toolArgs as Record<string, unknown>).slice(0, 12)}`)
await harness.dispose?.()
