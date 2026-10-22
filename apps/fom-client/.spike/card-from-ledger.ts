/**
 * 把产品台账里的真记录喂给纯函数 `buildApprovalCard`，看它在**发 HTTP 之前**会不会抛。
 *
 * 第 8 步真进程冒烟的现象：两次询问都没有卡到达飞书，而 `cards` 表根本没被创建过 ——
 * `putCard` 只在至少一条投递成功后才写，所以失败点在 `sendCard` 内部。
 * 这一段唯一只有产品路径会走、outbound 冒烟（桩台账）不走的就是 `relaxationCount`
 * 经真台账的 `requestsOf`，所以先把「组装」与「网络」切开判。
 *
 * 用法：node --import ../deepseek-harness/node_modules/tsx/dist/loader.mjs .spike/card-from-ledger.ts [requestId 前缀]
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApprovalCard, cardUuid, sessionRelaxationCount } from '../plugins/office-approval/feishu-channel.ts'
import type { ApprovalLedger, ApprovalRequestRecord } from '../plugins/office-approval/ledger.ts'

const here = dirname(fileURLToPath(import.meta.url))
const prefix = process.argv[2] ?? ''
const dir = 'C:/Users/EDY/.dsh/storages/office_approval_ledger/requests'

const records: ApprovalRequestRecord[] = readdirSync(dir)
  .filter(name => name.endsWith('.json') && name.startsWith(prefix))
  .map(name => (JSON.parse(readFileSync(resolve(dir, name), 'utf8')) as { record: ApprovalRequestRecord }).record)

console.log(`取到 ${String(records.length)} 条记录`)

/** 只兜住 `relaxationCount` 用到的那一个读口径。 */
function ledgerOf(all: ApprovalRequestRecord[]): ApprovalLedger {
  return { requestsOf: (sessionId: string) => all.filter(r => r.sessionId === sessionId) } as unknown as ApprovalLedger
}
const policy = { relaxationCount: sessionRelaxationCount(ledgerOf(records)) }

for (const record of records) {
  const label = `${record.requestId.slice(0, 8)} ${record.riskLevel} ${record.toolName}`
  try {
    const card = buildApprovalCard(record, { kind: 'awaiting' }, policy)
    const json = JSON.stringify(card)
    console.log(`组装 ok：${label}，uuid=${cardUuid(record.requestId, 'push')}，${String(json.length)} 字节`)
  } catch (error) {
    console.log(`组装抛：${label} -> ${String(error)}`)
    const cause = (error as { cause?: unknown }).cause
    if (cause !== undefined) console.log(`  cause: ${String(cause)}`)
  }
}
