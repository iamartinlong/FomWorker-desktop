/**
 * 只读核对：产品进程到底有没有把卡真的发出去。
 *
 * 判据不靠人眼扫聊天：列机器人所在会话的最近消息，看 `interactive` 那条是不是机器人（`app`）发的。
 * 用法：node .spike/feishu-ws/peek-outbox.mjs [chat_id]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const base = 'https://open.feishu.cn'

function readEnv(file) {
  const out = {}
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq > 0) out[t.slice(0, eq)] = t.slice(eq + 1)
  }
  return out
}

const env = readEnv(path.resolve(here, '../../.secrets/feishu-dev.env'))
const tokenReply = await (
  await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  })
).json()
if (tokenReply.code !== 0) throw new Error(`token issue failed: code=${tokenReply.code}`)

// chat_id 从长连接收到的那条消息里取（第 8 步 a 的 events.jsonl）。
let chatId = process.argv[2]
if (chatId === undefined) {
  for (const line of fs.readFileSync(path.join(here, 'events.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean)) {
    const row = JSON.parse(line)
    const found = row.payload?.chat_id ?? row.payload?.message?.chat_id
    if (typeof found === 'string' && found.startsWith('c')) {
      chatId = found
      break
    }
  }
}
if (chatId === undefined) throw new Error('没找到 chat_id：把会话 id 作为第一个参数传进来')

const url = new URL(`${base}/open-apis/im/v1/messages`)
url.searchParams.set('container_id_type', 'chat')
url.searchParams.set('container_id', chatId)
url.searchParams.set('sort_type', 'ByCreateTimeDesc')
url.searchParams.set('page_size', '20')

const reply = await (
  await fetch(url.toString(), { headers: { Authorization: `Bearer ${tokenReply.tenant_access_token}` } })
).json()
if (reply.code !== 0) {
  console.log(`列表失败 code=${reply.code} msg=${reply.msg}`)
  process.exit(1)
}
for (const item of reply.data?.items ?? []) {
  const body = item.body?.content ?? ''
  const snippet = body.length > 78 ? `${body.slice(0, 78)}…` : body
  console.log([
    new Date(Number(item.create_time)).toISOString(),
    item.msg_type.padEnd(12),
    (item.sender?.sender_type ?? '-').padEnd(5),
    item.message_id,
  ].join(' '))
  if (item.msg_type === 'interactive') console.log(`    ${snippet.replace(/\s+/g, ' ').slice(0, 110)}`)
}
