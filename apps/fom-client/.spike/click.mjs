// 模拟飞书卡片回调：把一个批准以正确签名 POST 进真路由。
import { createHash } from 'node:crypto'

const [requestId, decision = 'approve'] = process.argv.slice(2)
const token = process.env.OFFICE_APPROVAL_VERIFICATION_TOKEN ?? ''
const openId = process.env.SPIKE_APPROVER ?? 'ou_spike_approver'
const port = process.env.SPIKE_PORT ?? '3080'

const body = JSON.stringify({
  schema: '2.0',
  header: { event_id: `evt-${Date.now()}`, event_type: 'card.action.trigger', create_time: String(Date.now()) },
  event: {
    operator: { open_id: openId, user_id: openId },
    action: { value: { requestId, decision }, tag: 'approve_button' },
    context: { open_chat_id: 'oc_spike' },
  },
})
const timestamp = String(Date.now())
const nonce = 'spike-nonce-1'
const signature = createHash('sha1').update(`${timestamp}${nonce}${token}${body}`, 'utf8').digest('hex')

const res = await fetch(`http://127.0.0.1:${port}/office/approval/callback`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-lark-request-timestamp': timestamp,
    'x-lark-request-nonce': nonce,
    'x-lark-signature': signature,
  },
  body,
})
console.log(JSON.stringify({
  requestId, decision, status: res.status, windowNow: Date.now(),
  body: await res.text(),
}))
