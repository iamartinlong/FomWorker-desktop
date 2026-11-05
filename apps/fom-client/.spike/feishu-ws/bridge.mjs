/**
 * 飞书长连接桥接（§8 第 8 步：入站那一半）。
 *
 * 两条臂的差别只在**签名是谁算的**：
 * - 公网回调臂：飞书把卡片回传 POST 到我们的 URL，`X-Lark-Signature` 由飞书按
 *   `sha1(timestamp+nonce+Verification Token+body)` 算 —— 路由的验签分支真被外部签名喂过。
 * - 长连接臂（本文件）：飞书**不签**，它把事件推到我们用自己 App 凭证注册的 WS 上，
 *   真实性由那次握手保证。所以这里收到事件后按路由认的信封自签一份，转投本地 HTTP。
 *   转发的是**飞书推给我们的那份事件对象**：`event.operator.open_id` 与 `event.action.value`
 *   都是飞书给的，不是我们编的 —— 被替掉的只有传输层那层签名。
 *   结论：这条臂能证明「真点击 → 真身份 → 落账 → 唤醒」全环，**不能**当作公网验签的证据。
 *
 * 凭证只从 .secrets/feishu-dev.env 读，绝不打日志。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as lark from '@larksuiteoapi/node-sdk'

const here = path.dirname(fileURLToPath(import.meta.url))
const ENV_FILE = path.resolve(here, '../../.secrets/feishu-dev.env')
const EVENTS_LOG = path.join(here, 'events.jsonl')
const HB = path.join(here, 'heartbeat.txt')

function readEnv(file) {
  const out = {}
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    out[t.slice(0, eq)] = t.slice(eq + 1)
  }
  return out
}

const env = readEnv(ENV_FILE)
const appId = env.FEISHU_APP_ID
const appSecret = env.FEISHU_APP_SECRET
if (!appId || !appSecret) {
  console.error(`missing FEISHU_APP_ID / FEISHU_APP_SECRET in ${ENV_FILE}`)
  process.exit(1)
}

/** 空 = 只记录不落账（第一阶段的状态）；配了就把点击转投真路由。 */
const callbackUrl = env.OFFICE_APPROVAL_CALLBACK_URL ?? ''
const verificationToken = env.OFFICE_APPROVAL_VERIFICATION_TOKEN ?? ''
if (callbackUrl !== '' && verificationToken === '') {
  console.error('[forward] 配了回调地址但没有 Verification Token：路由会一律 401，先把 token 填进 env')
}

let seq = 0
function record(kind, payload) {
  seq += 1
  const row = {
    at: new Date().toISOString(),
    seq,
    kind,
    payload,
  }
  fs.appendFile(EVENTS_LOG, JSON.stringify(row) + '\n', () => {})
  fs.writeFile(HB, `${row.at} seq=${seq} kind=${kind}\n`, () => {})
  return row
}

/**
 * 长连接臂的转发：把飞书推来的事件转成**公网回调那份信封**再自签转投。
 *
 * 实测形状（`events.jsonl` 里的原始 payload）：SDK 交给我们的是**已经拆过外层的事件本体**
 * —— `operator` / `action` / `context` 直接躺在顶层，没有公网回调那层 `{header, event}`。
 * 原样 POST 会被路由的 `cardCallbackSchema` 判为「数据不完整」（第 8 步真人第一次点击就撞在这），
 * 所以这里包一层。包完，名单校验、CAS 落账、E13/唤醒这些真代码跑的是同一条路径。
 */
async function forwardCardAction(data) {
  const openId = data?.operator?.open_id ?? '(no operator)'
  const value = data?.action?.value
  console.log(`[card] operator=${openId} action.value=${JSON.stringify(value)}`)

  if (callbackUrl === '') return { toast: { type: 'warning', content: '已记录（未配回调地址，不落账）' } }

  const envelope = {
    schema: data?.schema ?? '2.0',
    header: {
      event_id: data?.event_id,
      event_type: data?.event_type ?? 'card.action.trigger',
      create_time: data?.create_time,
    },
    event: {
      operator: data?.operator,
      action: data?.action,
      context: data?.context,
    },
  }
  const rawBody = JSON.stringify(envelope)
  const timestamp = String(Date.now())
  const nonce = crypto.randomUUID()
  const signature = crypto
    .createHash('sha1')
    .update(`${timestamp}${nonce}${verificationToken}${rawBody}`, 'utf8')
    .digest('hex')

  let status = 0
  let text = ''
  try {
    const response = await fetch(callbackUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-lark-request-timestamp': timestamp,
        'x-lark-request-nonce': nonce,
        'x-lark-signature': signature,
      },
      body: rawBody,
    })
    status = response.status
    text = await response.text()
  } catch (error) {
    console.error(`[forward] failed: ${String(error)}`)
    return { toast: { type: 'error', content: '回调转发失败，本次点击没有生效' } }
  }
  console.log(`[forward] ${status} ${text}`)
  // toast 写的是路由的真答复：审批人必须知道自己那一下到底算不算数（§4 的反「点了没反应」）。
  return status === 200
    ? { toast: { type: 'success', content: '已记录' } }
    : { toast: { type: 'error', content: `未生效 ${status} ${text.slice(0, 60)}` } }
}

const dispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': (data) => {
    record('im.message.receive_v1', data)
    const sender = data?.sender ?? {}
    console.log(
      [
        '',
        '=== im.message.receive_v1 ===',
        `  open_id    : ${sender.open_id ?? sender.sender_id?.open_id ?? '(none)'}`,
        `  sender_type: ${sender.sender_type}`,
        `  chat_id    : ${data?.message?.chat_id}`,
        `  chat_type  : ${data?.message?.chat_type}`,
        `  msg_type   : ${data?.message?.message_type}`,
        `  content    : ${data?.message?.content}`,
        '',
      ].join('\n'),
    )
  },
  'card.action.trigger': async (data) => {
    record('card.action.trigger', data)
    const toast = await forwardCardAction(data)
    console.log(`[card] -> ${JSON.stringify(toast)}\n`)
    return toast
  },
})

console.log(`appId=${appId}`)
console.log(`events -> ${EVENTS_LOG}`)
console.log(`callback -> ${callbackUrl === '' ? '(未配置：只记录不落账)' : callbackUrl}`)
console.log('waiting for events ... Ctrl-C to stop')

const client = new lark.WSClient({
  appId,
  appSecret,
  loggerLevel: lark.LoggerLevel.info,
  onReady: () => {
    console.log('[ws] connected')
    fs.writeFile(HB, `${new Date().toISOString()} connected\n`, () => {})
  },
  onError: (err) => console.error('[ws] error:', err?.message ?? err),
  onReconnecting: () => console.log('[ws] reconnecting'),
  onReconnected: () => console.log('[ws] reconnected'),
})

client.start({ eventDispatcher: dispatcher }).catch((err) => {
  console.error('[ws] start failed:', err?.message ?? err)
  process.exit(1)
})

setInterval(() => {
  console.log(`[ws] status=${JSON.stringify(client.getConnectionStatus())}`)
}, 60000).unref()
