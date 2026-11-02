/**
 * 只读核对「卡变灰」那一步：把一条已决策的消息正文取回来，看按钮的 `disabled` 与页脚 `text_tag`。
 *
 * 用法：node .spike/feishu-ws/peek-card.mjs <message_id>
 * 为什么值得单写一个脚本：第 8 步的验收词是「点一次、**看卡变灰**」，而置灰是官方的 `disabled` 字段
 * （`feishu-channel.ts` 的 `settled` 判定）。人眼扫聊天会漏，接口读回来的字段不会。
 * 消息正文接口比列表接口及时（列表有约 10 分钟索引延迟，见冒烟记录 §3）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const base = 'https://open.feishu.cn'
const messageId = process.argv[2]
if (!messageId) { console.error('用法：node .spike/feishu-ws/peek-card.mjs <message_id>'); process.exit(1) }

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
const tokenReply = await (await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
})).json()
if (tokenReply.code !== 0) { console.error(`token 失败 code=${tokenReply.code}`); process.exit(1) }

const reply = await (await fetch(`${base}/open-apis/im/v1/messages/${messageId}`, {
  headers: { Authorization: `Bearer ${tokenReply.tenant_access_token}` },
})).json()
if (reply.code !== 0) { console.error(`读取失败 code=${reply.code} msg=${reply.msg}`); process.exit(1) }

const item = reply.data?.items?.[0] ?? {}
const raw = item.body?.content ?? item.content
// **接口读不回我们发的那本卡片**：schema 2.0 的正文经 `GET /im/v1/messages/{id}` 回来是兼容占位
// （`请升级至最新版本客户端，以查看内容` + 1.0 的嵌套 elements 数组），`disabled` 与页脚颜色都看不到。
// 所以这里的判据换成**改没改过**：`update_time` 晚于 `create_time` 且 `deleted:false` ⇒
// 那次就地改卡（决策/置灰）真的落到了飞书那边 —— 全进程里只有渠道会去 PATCH 这条消息。
const created = Number(item.create_time ?? 0)
const updated = Number(item.update_time ?? 0)
console.log(JSON.stringify({
  messageId: item.message_id,
  msgType: item.msg_type,
  deleted: item.deleted,
  ageMs: updated - created,
  patched: updated > created,
  bodyHead: String(raw).slice(0, 160),
  verdict: item.deleted === true ? '已撤回（DELETE 生效）'
    : updated > created ? '被就地改过（终态置灰已落地）'
    : '没改过：仍是待批准那张',
}))
if (raw !== undefined && raw.includes('"disabled"')) {
  // 万一哪天接口能读回真正文，这段就是原来那条更硬的判据。
  const card = JSON.parse(raw)
  const buttons = (card.body?.elements ?? []).filter(e => e.tag === 'button')
  console.log(JSON.stringify({
    buttons: buttons.map(b => ({ text: b.text?.content, disabled: b.disabled })),
    footerTags: (card.header?.text_tag_list ?? []).map(t => `${t.text?.content ?? t.text}=${t.color}`),
  }))
}
