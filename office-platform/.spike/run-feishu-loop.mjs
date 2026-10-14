/**
 * 起**产品进程**跑真飞书臂（§8 第 8 步 e）。
 *
 * 为什么是个脚本而不是一行命令：`FEISHU_APP_SECRET` 与 `OFFICE_APPROVAL_VERIFICATION_TOKEN`
 * 必须进子进程的环境，但不能出现在命令行里（argv 会被 `ps`/shell 历史/我们的日志抄走一遍）。
 * 同理，Web UI 那个带 token 的 URL 只写进 `.spike/feishu-loop.url`，stdout 只说「写好了」。
 *
 * 用法（在 `office-platform/` 下）：
 *   node .spike/run-feishu-loop.mjs [port]        # 默认 3081
 * 停止：Ctrl-C（本脚本会转 SIGINT 给子进程），或按 url 文件旁边 `.spike/feishu-loop.pid` 里的 PID。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const platform = path.resolve(here, '..')
const kernel = path.resolve(platform, '..', 'deepseek-harness')
const port = process.argv[2] ?? '3081'
const LOG = path.join(platform, '.spike', 'feishu-loop.log')
const URL_FILE = path.join(platform, '.spike', 'feishu-loop.url')
const PID_FILE = path.join(platform, '.spike', 'feishu-loop.pid')

const envFile = path.join(platform, '.secrets', 'feishu-dev.env')
const secrets = {}
for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const t = line.trim()
  if (!t || t.startsWith('#')) continue
  const eq = t.indexOf('=')
  if (eq > 0) secrets[t.slice(0, eq)] = t.slice(eq + 1)
}
for (const key of ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'OFFICE_APPROVAL_VERIFICATION_TOKEN']) {
  if (!secrets[key]) throw new Error(`${key} 在 ${envFile} 里是空的`)
}

fs.writeFileSync(LOG, '', 'utf8')
fs.rmSync(URL_FILE, { force: true })

const child = spawn(
  process.execPath,
  [
    '--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web',
    // 顺序是**实测**出来的：启动器在第一个它不认的旗标处就把所有权交给应用
    // （`apps/cli/src/args.ts:161-166` 的 `allowUnknownOption` + `passThroughOptions`），
    // 所以 `--port` 一旦排在 `--patch` 前面，`--patch` 就成了应用的参数 ——
    // 报 `error: unknown option '--patch'`，第 8 步第一次起进程就是这么撞墙的。
    '--patch', path.join(platform, 'office-approval.feishu.patch.yml'),
    '--patch', path.join(kernel, 'office.patch.yml'),
    '--port', port, '--no-open',
  ],
  {
    cwd: kernel,
    env: {
      ...process.env,
      FEISHU_APP_SECRET: secrets.FEISHU_APP_SECRET,
      OFFICE_APPROVAL_VERIFICATION_TOKEN: secrets.OFFICE_APPROVAL_VERIFICATION_TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)
fs.writeFileSync(PID_FILE, String(child.pid), 'utf8')

const sink = fs.createWriteStream(LOG, { flags: 'a' })
child.stdout.pipe(sink)
child.stderr.pipe(sink)
// stdout 只用来扫 URL，不回显 —— 那行里带着 token。
child.stdout.on('data', chunk => {
  if (fs.existsSync(URL_FILE)) return
  const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)
  if (match !== null) fs.writeFileSync(URL_FILE, `${match[0]}\n`, 'utf8')
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal)
    process.exit(0)
  })
}
child.on('exit', code => {
  console.log(`dsh 退出 code=${code}（端口被占时真退出码是 1；日志 ${LOG}）`)
  process.exit(code ?? 1)
})

/** 就绪判据：回调路由挂着且只收 POST → 405。`/` 在启动过程中先 404 再 401，不能拿来判。 */
const probe = `http://127.0.0.1:${port}/office/approval/callback`
// 300 秒而不是 120 秒：`.dsh` 里攒了几十个会话与一叠台账记录之后，真启动量到 ~100 秒，
// 120 秒的窗口两次把「还在起」误判成「起不来」，还把子进程留成孤儿。
const deadline = Date.now() + 300_000
for (;;) {
  try {
    const response = await fetch(probe, { method: 'GET' })
    if (response.status === 405) break
  } catch {
    /* 还没 listen */
  }
  if (Date.now() > deadline) {
    // 不杀掉子进程的话，它会带着已经 listen 上的端口变成孤儿 —— 下一次启动就撞端口。
    child.kill('SIGTERM')
    console.log('300 秒内没有等到 405：看 ' + LOG + ' 与 C:/Users/EDY/.dsh/logs/startup-*.log')
    process.exit(1)
  }
  await new Promise(resolve => setTimeout(resolve, 1000))
}
console.log(`ready: ${probe} -> 405；pid=${child.pid}（写在 ${PID_FILE}）`)
console.log(fs.existsSync(URL_FILE) ? `Web UI URL 已写入 ${URL_FILE}（含 token，未回显）` : `没扫到带 token 的 URL，从 ${LOG} 里找`)
