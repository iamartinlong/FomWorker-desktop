/**
 * 卡片 schema 探针 · 第 2 轮：第 1 轮定死了「action/note 在 2.0 不再支持、按钮要平铺」，
 * 剩下唯一没定的问题是**状态标记**怎么画。逐个候选发给飞书，当场撤回。
 *
 * 用法：node .spike/feishu-card-probe2.mjs [open_id]
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const base = 'https://open.feishu.cn'

function readEnv(file) {
  const out = {}
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

const tokenReply = await (
  await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  })
).json()
if (tokenReply.code !== 0) throw new Error(`token issue failed: code=${tokenReply.code}`)
const token = tokenReply.tenant_access_token

async function call(path, body, query) {
  const url = new URL(base + path)
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  return await (
    await fetch(url.toString(), {
      method: body === undefined ? 'DELETE' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  ).json()
}

const plain = content => ({ tag: 'plain_text', content })
const withBody = extra => ({
  schema: '2.0',
  config: { update_multi: true },
  header: { title: plain('探针 2') },
  body: { elements: [{ tag: 'markdown', content: '正文' }, ...extra] },
})

const tagItem = { tag: 'text_tag', text: plain('待批准'), color: 'blue' }
const candidates = [
  ['K1 header.text_tag_list[text_tag]', { ...withBody([]), header: { title: plain('K1'), template: 'blue', text_tag_list: [tagItem] } }],
  ['K2 元素 tag_list', withBody([{ tag: 'tag_list', items: [tagItem] }])],
  ['K3 元素 text_tag', withBody([tagItem])],
  ['K4 header.subtitle', { ...withBody([]), header: { title: plain('K4'), template: 'blue', subtitle: plain('待批准') } }],
  ['K5 markdown 着色', withBody([{ tag: 'markdown', content: "<font color='blue'>待批准</font>" }])],
  ['K6 元素 column_set', withBody([{ tag: 'column_set', flex_mode: 'none', background_style: 'grey', columns: [{ tag: 'column', width: 'auto', elements: [{ tag: 'markdown', content: '列' }] }] }])],
]

const results = []
for (const [name, payload] of candidates) {
  const reply = await call('/open-apis/im/v1/messages', {
    receive_id: openId,
    msg_type: 'interactive',
    content: JSON.stringify(payload),
  }, { receive_id_type: 'open_id' })
  const messageId = reply.data?.message_id
  let retracted = '-'
  if (messageId !== undefined) {
    const del = await call(`/open-apis/im/v1/messages/${messageId}`)
    retracted = del.code === 0 ? '撤回 ok' : `撤回失败 ${del.code}`
  }
  results.push({
    候选: name,
    结果: reply.code === 0 ? `OK (${retracted})` : `REJECT code=${reply.code} ${String(reply.msg).slice(0, 240)}`,
  })
}
console.table(results)
