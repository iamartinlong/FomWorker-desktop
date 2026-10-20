/**
 * 飞书 outbound 冒烟（§8 第 8 步）：让**真的渠道代码**把卡发到真人身上。
 *
 * 走的是 `installFeishuApprovalChannel` 本体 + 真 HTTP 传输 + 真 tenant token 缓存，
 * 只有台账是内存桩 —— 台账语义已被 151 例钉住，这里要看的恰恰是那些用例够不着的部分：
 * 卡片 schema 飞书收不收（2.0 / 按钮回传值）、就地改卡、撤回超窗、发文本。
 *
 * 用法（在 `apps/fom-client/` 下）：
 *   FEISHU_APP_SECRET=… node --import ../deepseek-harness/node_modules/tsx/dist/loader.mjs \
 *     .spike/feishu-smoke-send.ts [open_id]
 *
 * 默认发两张：A 走完「发 → 改 → 撤 → 补一句话」全序列，B 留在会话里**等人点**，
 * 点的那一下由 `.spike/feishu-ws/bridge.mjs` 收 `card.action.trigger`。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  alreadyGoneCodes, buildApprovalCard, cardUuid, createTenantTokenSource, FeishuApiError,
  installFeishuApprovalChannel, type ApprovalCardState,
} from '../plugins/office-approval/feishu-channel.ts'
import { createHttpFeishuTransport } from '../plugins/office-approval/feishu-transport-http.ts'
import type { ApprovalLedger, ApprovalRequestRecord } from '../plugins/office-approval/ledger.ts'

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
const appId = process.env.FEISHU_APP_ID ?? env.FEISHU_APP_ID ?? ''
const appSecret = process.env.FEISHU_APP_SECRET ?? env.FEISHU_APP_SECRET ?? ''
const openId = process.argv[2] ?? 'ou_e66ad5f9e6604d4184d17215b1c2adc7'
if (!appId || !appSecret) throw new Error('missing FEISHU_APP_ID / FEISHU_APP_SECRET')

/** 台账桩：只兜住渠道真正用到的四个读写的口径。 */
function stubLedger(): ApprovalLedger {
  const records = new Map<string, ApprovalRequestRecord>()
  const cards = new Map<string, { requestId: string; messageIds: readonly string[]; recipientIds: readonly string[]; pushedAt: number }>()
  const ledger = {
    get: (id: string) => records.get(id),
    put: (record: ApprovalRequestRecord) => { records.set(record.requestId, record) },
    putCard: async (handle: { requestId: string; messageIds: readonly string[]; recipientIds: readonly string[]; pushedAt: number }) => {
      cards.set(handle.requestId, handle)
    },
    cardHandle: (id: string) => cards.get(id),
    requestsOf: (sessionId: string) => [...records.values()].filter(r => r.sessionId === sessionId),
  }
  return ledger as unknown as ApprovalLedger
}

function record(requestId: string, riskLevel: 'L2' | 'L3'): ApprovalRequestRecord {
  const at = Date.now()
  return {
    requestId,
    sessionId: 'smoke-session',
    tenantId: 'tenant-local',
    toolName: riskLevel === 'L3' ? 'pwsh' : 'write',
    riskLevel,
    actionSummary: riskLevel === 'L3'
      ? '执行命令：Remove-Item -Recurse -Force C:\\Users\\EDY\\workspace\\report-cache'
      : '写入 /office/outbox/weekly.md',
    toolArgs: riskLevel === 'L3'
      ? { command: 'Remove-Item -Recurse -Force C:\\Users\\EDY\\workspace\\report-cache', sandbox_permissions: 'full_access', justification: '缓存目录在沙箱可写范围之外，需要清掉旧数据才能重跑出图' }
      : { file_path: '/office/outbox/weekly.md', content: '# 周报\n' },
    displayReason: '这个动作要删掉工作区之外的一个目录，且不可逆；模型给出的理由是缓存目录不在沙箱可写范围内。',
    status: 'pending',
    askedAt: at,
    windowEndsAt: at + 90_000,
    expiresAt: at + 15 * 60_000,
    decidedBy: null,
    decidedAt: null,
  }
}

const transport = createHttpFeishuTransport({ timeoutMs: 15_000 })
const tokens = createTenantTokenSource(transport, appId, appSecret)
const ledger = stubLedger()
const failures: string[] = []
const channel = installFeishuApprovalChannel({
  transport,
  tokens,
  ledger,
  recipientsOf: () => [openId],
  initiatorOf: () => openId,
  policy: { relaxationCount: () => 1 },
  onFailure: (error, context) => { failures.push(`${context.path}: ${String(error)}`) },
})

const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '')
const recA = record(`smoke-A-${stamp}`, 'L3')
const recB = record(`smoke-B-${stamp}`, 'L2')
;(ledger as unknown as { put: (r: ApprovalRequestRecord) => void }).put(recA)
;(ledger as unknown as { put: (r: ApprovalRequestRecord) => void }).put(recB)

const abort = new AbortController().signal
console.log(`approver open_id = ${openId}`)

console.log('1) 发卡 A（L3，带二次确认区块）')
const cardA = await channel.send(recA, abort)
console.log('   card A ->', JSON.stringify(cardA))

console.log('2) 发卡 B（L2，留在会话里等你点）')
const cardB = await channel.send(recB, abort)
console.log('   card B ->', JSON.stringify(cardB))

console.log('3) 就地改卡 A（写"已由冒烟脚本批准"并把按钮置灰）')
await channel.update(cardA, '已由 smoke-A 批准（这是就地改卡，不是撤回）')
console.log('   ok')

console.log('4) 撤回 A 并另发一句文本')
await channel.recall(cardA, '这张卡是冒烟用的，已撤回。')
console.log('   ok')

console.log('5) 催办重推 B 一次（换 uuid 的新卡 + 旧卡置灰）')
await channel.pushReminder(recB)
console.log('   ok')

const handle = (ledger as unknown as {
  cardHandle: (id: string) => { messageIds: readonly string[] } | undefined
}).cardHandle(recA.requestId)
console.log(`\nA 的 message_id 句柄：${JSON.stringify(handle?.messageIds)}`)
console.log(`失败上报（应为空）：${JSON.stringify(failures)}`)
console.log(`\nuuid 复查：A 首推 ${cardUuid(recA.requestId, 'push')} / B 首推 ${cardUuid(recB.requestId, 'push')} / B 催办 ${cardUuid(recB.requestId, 'remind')}`)
console.log('现在到飞书里点 B 那张「批准」，然后看 .spike/feishu-ws/bridge.log')

// 让 230009 这类"真失败"与"目的已达到"在日志里可读（脚本没走到就 harmless）。
void alreadyGoneCodes
void buildApprovalCard
void FeishuApiError
void ({} as ApprovalCardState)
