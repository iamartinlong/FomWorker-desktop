/**
 * 卡片 schema 探针（§8 第 8 步）。
 *
 * 飞书文档页是 JS 渲染的，抓不到组件白名单；那就让**飞书自己**告诉我们哪个构造可用 ——
 * 它的报错形状是 `not support tag: X`，正好逐个定位。每张探针卡发出后立刻撤回，
 * 会话里不会留下一堆垃圾（顺带把 send + DELETE 两条真实调用也走了一遍）。
 *
 * 用法（在 `apps/fom-client/` 下）：node .spike/feishu-card-probe.mjs [open_id]
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
  const reply = await (
    await fetch(url.toString(), {
      method: body === undefined ? 'DELETE' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  ).json()
  return reply
}

const plain = content => ({ tag: 'plain_text', content })
const card = (name, extra) => ({
  schema: '2.0',
  config: { update_multi: true },
  header: { title: plain(`探针 ${name}`) },
  body: { elements: [{ tag: 'div', text: plain('如果看到这句话说明卡片头与正文可用') }, ...extra] },
})

const button = (label, extra = {}) => ({
  tag: 'button',
  text: plain(label),
  type: 'primary',
  behaviors: [{ type: 'callback', value: { requestId: 'probe', decision: 'approve' } }],
  ...extra,
})

/**
 * 每个候选只测一件事，绿了才知道 `buildApprovalCard` 里那个构造到底收不收。
 * `expect` 是写代码时的假设，跑完对着真结果改。
 */
const candidates = [
  ['A-markdown', card('A', [{ tag: 'markdown', content: '**markdown** 组件' }]), 'markdown 元素可用'],
  ['B-larkmd-div', card('B', [{ tag: 'div', text: { tag: 'lark_md', content: '**lark_md** 在 div.text 里' } }]), '2.0 仍接受 div.text = lark_md'],
  ['C-action-wrap', card('C', [{ tag: 'action', actions: [button('批准')] }]), 'action 包裹按钮可用'],
  ['D-button-flat', card('D', [button('批准')]), 'button 作为顶层元素可用'],
  ['E-disabled', card('E', [button('批准', { disabled: true })]), 'disabled 字段可用'],
  ['F-confirm', card('F', [button('批准', { confirm: { title: plain('确认？'), text: plain('不可逆') } })]), 'confirm 弹窗字段可用'],
  ['G-template', { ...card('G', []), header: { title: plain('探针 G'), template: 'blue' } }, 'header.template 着色可用'],
  ['H-texttag', { ...card('H', []), header: { title: plain('探针 H'), text_tag_list: [{ tag: 'blue', text: plain('待批准') }] } }, 'header.text_tag_list（tag 用颜色名）可用'],
  ['I-note', card('I', [{ tag: 'note', elements: [plain('note 元素')] }]), 'note 元素可用'],
  ['J-hr', card('J', [{ tag: 'hr' }]), 'hr 元素可用'],
]

const results = []
for (const [name, payload, expect] of candidates) {
  const reply = await call('/open-apis/im/v1/messages', {
    receive_id: openId, // 官方口径：`receive_id` 在 body，`receive_id_type` 在 query
    msg_type: 'interactive',
    content: JSON.stringify(payload),
  }, { receive_id_type: 'open_id' })
  const messageId = reply.data?.message_id
  let retracted = '-'
  if (messageId !== undefined) {
    const del = await call(`/open-apis/im/v1/messages/${messageId}`)
    retracted = del.code === 0 ? '撤回 ok' : `撤回失败 ${del.code}`
  }
  const verdict = reply.code === 0 ? `OK (code=0, ${retracted})` : `REJECT code=${reply.code} msg=${String(reply.msg).slice(0, 260)}`
  results.push({ 候选: name, 假设: expect, 结果: verdict })
}

console.table(results)
