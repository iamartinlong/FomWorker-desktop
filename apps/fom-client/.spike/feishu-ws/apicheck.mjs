/**
 * 出站侧体检：只证明"这个应用能拿到 token、机器人能力开着、能识别人"。
 * 任何 token 都不打印，只打 code / msg / 字段名。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const env = {}
for (const line of fs
  .readFileSync(path.resolve(here, '../../.secrets/feishu-dev.env'), 'utf8')
  .split(/\r?\n/)) {
  const t = line.trim()
  if (!t || t.startsWith('#')) continue
  const eq = t.indexOf('=')
  if (eq > 0) env[t.slice(0, eq)] = t.slice(eq + 1)
}

const BASE = 'https://open.feishu.cn'
const appId = env.FEISHU_APP_ID

async function j(url, opts) {
  const res = await fetch(url, opts)
  let body
  try {
    body = await res.json()
  } catch {
    body = { unparsable: true }
  }
  return { http: res.status, body }
}

const tok = await j(`${BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ app_id: appId, app_secret: env.FEISHU_APP_SECRET }),
})
console.log(`token: http=${tok.http} code=${tok.body.code} msg=${tok.body.msg} expire=${tok.body.expire} token_len=${(tok.body.tenant_access_token ?? '').length}`)
const access = tok.body.tenant_access_token
if (!access) process.exit(1)

const H = { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json; charset=utf-8' }

const bot = await j(`${BASE}/open-apis/bot/v3/info`, { headers: H })
console.log(`bot/info: http=${bot.http} code=${bot.body.code} msg=${bot.body.msg}`)
if (bot.body.bot) {
  console.log(
    `  bot fields: ${Object.keys(bot.body.bot).join(', ')}\n` +
      `  app_name=${bot.body.bot.app_name} open_id=${bot.body.bot.open_id ? 'present' : 'absent'}`,
  )
}

const modes = ['open_id', 'union_id', 'user_id']
for (const m of modes) {
  const r = await j(
    `${BASE}/open-apis/contact/v3/users/batch_get_id?user_id_type=${m}`,
    { method: 'POST', headers: H, body: JSON.stringify({ mobiles: ['+8600000000000'] }) },
  )
  console.log(
    `batch_get_id(${m}): http=${r.http} code=${r.body.code} msg=${r.body.msg ?? ''} err_desc=${JSON.stringify(r.body.error ?? '').slice(0, 200)}`,
  )
}
