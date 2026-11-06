/**
 * 给长连接臂补两份配置：一个**我们自己**的 Verification Token（公网那一程该由飞书后台下发，
 * WS 模式没有这一程，所以它只是桥接进程与路由之间的共享密钥），和回调地址。
 *
 * 打印时只报键名与长度，绝不回显值。用法：node .spike/feishu-ws/setup-env.mjs [port]
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const file = path.resolve(here, '../../.secrets/feishu-dev.env')
const port = process.argv[2] ?? '3081'
const token = randomBytes(24).toString('hex')
const url = `http://127.0.0.1:${port}/office/approval/callback`

const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
let replaced = false
let appended = false
const next = lines.map(line => {
  if (/^OFFICE_APPROVAL_VERIFICATION_TOKEN=/.test(line)) {
    replaced = true
    return `OFFICE_APPROVAL_VERIFICATION_TOKEN=${token}`
  }
  return line
})
if (!replaced) {
  next.push(`OFFICE_APPROVAL_VERIFICATION_TOKEN=${token}`)
  appended = true
}
if (!next.some(line => /^OFFICE_APPROVAL_CALLBACK_URL=/.test(line))) {
  next.push(`OFFICE_APPROVAL_CALLBACK_URL=${url}`)
  appended = true
}

fs.writeFileSync(file, next.join('\n'), 'utf8')
console.log(`OFFICE_APPROVAL_VERIFICATION_TOKEN: ${replaced ? '已替换空值' : '新增'}（${token.length} 字符，未回显）`)
console.log(`OFFICE_APPROVAL_CALLBACK_URL=${url}${appended ? '（新增）' : ''}`)
