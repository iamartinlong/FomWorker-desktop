/**
 * 记忆层 §7 第 6 步真进程观测的**无浏览器驱动**：经 dsh web 的 `/api` Typert RPC 建会话 / 发 prompt /
 * 读一条会话的判定输入，让「双侧观测」不必开浏览器。
 *
 * 为什么是 RPC 而不是直接动磁盘：会话与回合由内核 AgentLoop 拥有，外部只能经这条已装好鉴权的入口驱动；
 * 直接写 session jsonl 会绕开「模型→工具→闸」这条正是要被观测的路径。
 *
 * 鉴权（`packages/client/connection/src/browser-auth.ts`）：`GET /?token=<launchToken>` 换一张 **authority 绑定**
 * 的签名 cookie（`dsh-auth-<sha256(authority)>`），之后每个 `/api/...` POST 都带它；Host 必须是 loopback
 * （`api-request-trust.ts`）。launchToken 每次进程启动都变，**只在进程日志的 `dsh web:` 行里**（stdout），
 * 所以调用方要先把那一行取出来写进 `<role>.url`（`run-step6.mjs` 就是这么做的）。
 *
 * 线格式（`api/gateway/src/client/index.ts:445`）：`POST /api/<endpoint>`，body
 *   `{ type:'client-request', rpcId, method:'<endpoint>', payload:{ args: { <wireParam>: value } } }`
 * wire 参数名按内核方法形参名逐字（`session/list(_request)` ⇒ `_request`；`session/create(request)` ⇒ `request`），
 * 猜错时网关会以 `gateway/arguments-invalid` **精确报出缺哪个 / 多哪个**，照它改即可。
 *
 * 用法（在能跑 node 的任意目录；需要 `<role>.url` 与 `<role>.sid` 两个状态文件，与 `run-step6.mjs` 同目录命名）：
 *   node .spike/api-drive.mjs <urlFile> create [cwd]     # 建会话并落 <urlFile 去 .url>.sid
 *   node .spike/api-drive.mjs <urlFile> prompt <text...>  # 向已落 sid 的会话发一条 prompt
 *   node .spike/api-drive.mjs <urlFile> list              # 列会话（连通性自检）
 */
import fs from 'node:fs'

const [urlFile, cmd, ...rest] = process.argv.slice(2)
if (urlFile === undefined || cmd === undefined) {
  console.error('usage: node .spike/api-drive.mjs <urlFile> create [cwd] | prompt <text...> | list')
  process.exit(2)
}

const base = fs.readFileSync(urlFile, 'utf8').trim()
const u = new URL(base)
const token = u.searchParams.get('token')
const origin = `${u.protocol}//${u.host}`

const idx = await fetch(`${origin}/?token=${token}`, { redirect: 'manual' })
const cookie = idx.headers.get('set-cookie')?.split(';')[0]
if (!cookie) throw new Error('token exchange returned no cookie (token stale? reread dsh web: line)')

async function rpc(endpoint, args) {
  const body = { type: 'client-request', rpcId: crypto.randomUUID(), method: endpoint, payload: { args } }
  const res = await fetch(`${origin}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, result: json?.result }
}

const sidFile = urlFile.replace(/\.url$/, '.sid')
const readSid = () => fs.existsSync(sidFile) ? fs.readFileSync(sidFile, 'utf8').trim() : ''

if (cmd === 'create') {
  const cwd = rest[0]
  const r = await rpc('session/create', { request: cwd ? { cwd } : {} })
  console.log(JSON.stringify(r, null, 2))
  if (r.result?.ok) fs.writeFileSync(sidFile, r.result.value.sessionId, 'utf8')
} else if (cmd === 'list') {
  const r = await rpc('session/list', { _request: {} })
  console.log(JSON.stringify(r.result, null, 2).slice(0, 2000))
} else if (cmd === 'prompt') {
  const sessionId = readSid()
  if (sessionId === '') throw new Error(`no ${sidFile}; run "create" first`)
  const text = rest.join(' ')
  const r = await rpc('session/prompt', {
    request: { requestId: crypto.randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }] },
  })
  console.log(JSON.stringify(r, null, 2))
} else {
  console.error(`unknown command: ${cmd}`)
  process.exit(2)
}
