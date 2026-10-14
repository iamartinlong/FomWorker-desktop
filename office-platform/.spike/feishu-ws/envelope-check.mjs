/**
 * 只做一件事：**证明长连接臂包出来的信封能被真路由解析**。
 *
 * 第 8 步真人第一次点击撞在 `这个按钮的数据不完整` 上 —— SDK 交给我们的是拆过外层的事件本体
 * （`operator`/`action` 在顶层），而路由的 `cardCallbackSchema` 认的是公网回调那份 `{event:{…}}`。
 * 这里拿 `events.jsonl` 里那份**飞书原样推来的**事件，按 bridge 同样的方式包一层，
 * 但把 requestId 换成一个不存在的编号再自签转投：
 * - 回「这条审批已经不存在了」⇒ 信封过了 schema，签名也过了（否则是 401 / 数据不完整）。
 * - 绝不用真编号打这一枪：那会把一条等着人点的审批替用户批掉，卡片随之置灰，真人那一下就没证据了。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const envFile = path.resolve(here, '../../.secrets/feishu-dev.env')
const env = Object.fromEntries(fs.readFileSync(envFile, 'utf8').split(/\r?\n/)
  .map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))

const callbackUrl = env.OFFICE_APPROVAL_CALLBACK_URL
const token = env.OFFICE_APPROVAL_VERIFICATION_TOKEN
if (!callbackUrl || !token) { console.error('缺 OFFICE_APPROVAL_CALLBACK_URL / OFFICE_APPROVAL_VERIFICATION_TOKEN'); process.exit(1) }

const lines = fs.readFileSync(path.join(here, 'events.jsonl'), 'utf8').trim().split(/\r?\n/)
const raw = JSON.parse(lines[lines.length - 1]).payload
if (raw.event_type !== 'card.action.trigger') { console.error(`最后一条不是卡片事件：${raw.event_type}`); process.exit(1) }

const envelope = {
  schema: raw.schema ?? '2.0',
  header: { event_id: raw.event_id, event_type: raw.event_type, create_time: raw.create_time },
  event: { operator: raw.operator, action: raw.action, context: raw.context },
}
envelope.event.action = { ...raw.action, value: { requestId: 'envelope-shape-check-does-not-exist', decision: 'approve' } }

const rawBody = JSON.stringify(envelope)
const timestamp = String(Date.now())
const nonce = crypto.randomUUID()
const signature = crypto.createHash('sha1').update(`${timestamp}${nonce}${token}${rawBody}`, 'utf8').digest('hex')

const res = await fetch(callbackUrl, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-lark-request-timestamp': timestamp,
    'x-lark-request-nonce': nonce,
    'x-lark-signature': signature,
  },
  body: rawBody,
})
const text = await res.text()
// 只看答复，不打正文之外的东西；token 全程只在签名串里。
console.log(JSON.stringify({
  wrappedKeys: Object.keys(envelope),
  status: res.status,
  reply: text,
  verdict: text.includes('数据不完整') ? 'FAIL 信封仍未过 schema'
    : res.status === 401 ? 'FAIL 验签没过'
    : 'PASS 信封与签名都被真路由接受（且未碰到任何真审批）',
}))
