/**
 * 记忆层 §7 第 6 步「双进程真组合」的启动器：一条命令把**成员进程**与**蒸馏进程**都起来，
 * 并在起之前把两个冷启动（各约 100s）最容易白等的东西检查掉。
 *
 * 与 `boot-step3.mjs` 的关系：spawn / 轮询 / 从日志里取带 token 的 URL 这三段是同一套已被实测的代码，
 * 差别只有四处，每处都是这一步特有的：
 * 1. **两个进程、两份 patch 组合**。成员叠 `office-approval` + `session-query`(durable) + `office-memory`(成员角色)；
 *    蒸馏只叠 `office-distill.workspace.patch.yml`（**不挂 approval**）。少叠一份就观测不到对应那半侧。
 * 2. **蒸馏进程没有 405 探针可用**：它根本没挂 approval 路由，所以就绪判据改成「日志里出现带 token 的 URL」
 *    （那行是 web 服务开始监听之后才打的，与 405 等价可靠，且不依赖我们自己的插件）。
 * 3. **反过来把 405 当故障用**：蒸馏进程那个端口**如果**回答了 405，说明 approval 不知被谁挂进来了
 *    ⇒ ME8「零卡是构造性成立」的前提当场破产，这次观测无效 —— 与其跑一整夜再发现，不如起进程时就杀掉。
 * 4. **起手基线落盘** `.spike/step6-baseline.json`（在**两进程就绪之后、任何会话动作之前**写，见下面填 `pids` 的那段）：
 *    `requests/` 与 `office_memory_run` 的**计数 + 文件名清单**、
 *    日级清单、水位线、`MEMORY.md` 与手改靶正文的 sha256。观测要的三条判据（ME8 的 `requests/` 文件名集合
 *    没多出蒸馏那一臂的卡——成员那一臂出卡是正确的一半，所以判据是「新增张数 == `--cards-expected`」而不是「计数不变」、
 *    ME10 悬空行消失、V2 手改正文一字节没动）全是**差值**，没有基线就只能靠肉眼回忆。
 *    这段算法不在本文件里，而在 `step6-baseline.mjs` —— 因为它的对端是 `verify-step6.ts`，两边各写一遍
 *    同一段算法迟早漂（抽出来当场就抓到两处：手改靶路径被写死、水位线文件缺失时直接 ENOENT 崩），
 *    漂移的代价是整夜观测白跑；`selftest-step6-baseline.ts` 用**同一份生产者**喂判据机，把这条契约钉住。
 *    这里刻意只记计数、文件名与哈希，不记台账记录正文 —— 台账目录在 `.dsh` 下，逐条转储不是这一步的需要。
 *
 * 用法：
 *   node .spike/run-step6.mjs --dry-run        # 只跑检查 + 打印两条将执行的命令（不起进程）
 *   node .spike/run-step6.mjs                  # 真起两个进程（需本人在场做后续观测）
 *   node .spike/run-step6.mjs --member-port 3095 --distill-port 3096
 *
 * ⚠️ 端口 3081 是自用验收那台实例，永远不抢、不杀。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { buildBaseline, listDailyDays, readWatermark } from './step6-baseline.mjs'
import { ensureDistillHome } from './distill-home.mjs'

const KERNEL = String.raw`F:\deepseek\deepseek harness\deepseek-harness`
const PLATFORM = String.raw`F:\deepseek\deepseek harness\apps\fom-client`
const SPIKE = path.join(PLATFORM, '.spike')
const MEMORY = path.join(SPIKE, 'distill-workspace')
// F-6A：蒸馏进程用**独立 DSH_HOME**，它的 storages/schedule.json 与 office_memory_run 都落在自己这儿，
// 不再与成员进程共写同一份 schedule.json（否则任一方写任务都会整份重写、抹掉/堆叠对方的 nightly 行）。
// ⚠️ 必须与 `~/.dsh` **同卷**（都在 C:）—— `.credentials.yaml` 等文件靠硬链接共享，而硬链接不能跨卷。
const DISTILL_HOME = 'C:/Users/EDY/.dsh-distill'
const CALLBACK = '/office/approval/callback'
const LEDGER_REQUESTS = 'C:/Users/EDY/.dsh/storages/office_approval_ledger/requests'
// storage-json 的 per-record 落盘是 `<domain>/<table>/<id>.json`：域名那一层数出来的是**表名**（永远 1），
// 不是记录数。台账计数必须下到表这一层（与上面 requests 同层）。蒸馏的 run 台账在它自己的 home 下。
const MEMORY_RUN = path.join(DISTILL_HOME, 'storages/office_memory_run/runs')

const argv = process.argv.slice(2)
const flag = name => argv.includes(`--${name}`)
const value = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index < 0 ? fallback : Number(argv[index + 1])
}
const MEMBER_PORT = value('member-port', 3085)
const DISTILL_PORT = value('distill-port', 3086)
const DRY_RUN = flag('dry-run')

const memberPatches = ['office-approval.patch.yml', 'session-query.spike.patch.yml', 'office-distill.member.patch.yml']
const distillPatches = ['office-distill.workspace.patch.yml']

const problems = []
const notes = []

/** 种子必须在场：没有水位线之后的日级，`distillOnce` 会直接 no-op，一整夜什么守卫都观测不到。 */
function checkSeed() {
  const days = listDailyDays(MEMORY)
  const watermark = readWatermark(MEMORY)
  if (watermark === null) {
    problems.push('daily/.watermark 不在场或形状不对（要 `{lastDistilledAt:number,lastDay:string}`）⇒ 先跑 node .spike/seed-distill.mjs')
    return
  }
  const newDays = days.filter(day => day > watermark.lastDay)
  if (newDays.length === 0) {
    problems.push(`水位线（${watermark.lastDay}）之后没有新日级 ⇒ 蒸馏会 no-op 收工。先跑 node .spike/seed-distill.mjs`)
  } else {
    notes.push(`newDays=${newDays.join(',')}（蒸馏有事可做）`)
  }
}

/**
 * DM7「双进程共用同一个记忆目录」的前提是**两个进程挂的 memoryRoot 与启动器算基线用的目录三者同一路径**。
 * 这个等式此前只被 `--dump-config` 的输出**看过**，没有任何断言：挂载件里的路径与这里的 `MEMORY` 各写一遍，
 * 改了一边不会报错——那一夜两个进程会各自读写一个目录，基线描述的还是第三个，判据机把「没发生」读成「被违反」。
 * 所以起进程前用文本读回两份挂载件的 `memoryRoot` / `workspaceRoot`，与 `MEMORY` 逐字比（Windows 大小写不敏感、
 * 斜杠方向不参与比较）。蒸馏那份还多一条：它的 `workspaceRoot` 必须等于它自己的 `memoryRoot`，否则「写自家
 * 记忆不 fence」（ME8 构造性成立的那半）不成立。
 */
function checkSharedMemoryDir(role, patches) {
  const normalize = p => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const want = normalize(MEMORY)
  for (const patch of patches) {
    const file = path.join(PLATFORM, patch)
    if (!file.endsWith('distill.member.patch.yml') && !file.endsWith('distill.workspace.patch.yml')) continue
    if (!fs.existsSync(file)) continue // 缺席已由上面「挂载件不存在」报过，这里不再重复读
    const text = fs.readFileSync(file, 'utf8')
    const found = new Map()
    for (const match of text.matchAll(/^\s*(memoryRoot|workspaceRoot):\s*'?([^'\r\n]+?)'?\s*$/gm)) {
      // 注释行里的键名不算声明（两份挂载件的说明段都写着这两个词）。
      if (match[0].trimStart().startsWith('#')) continue
      found.set(match[1], match[2].trim())
    }
    const memoryRoot = found.get('memoryRoot')
    if (!memoryRoot) {
      problems.push(`${patch} 里读不到 memoryRoot（形状变了？这份启动器不再猜路径，直接拒起）`)
      continue
    }
    if (normalize(memoryRoot) !== want) {
      problems.push(`${patch} 的 memoryRoot=${memoryRoot} ≠ 启动器算基线用的 ${MEMORY} ⇒ 那一夜两个进程读写的不是同一个目录（DM7 破产）`)
    }
    const workspaceRoot = found.get('workspaceRoot')
    if (role === 'distill' && normalize(workspaceRoot ?? '') !== normalize(memoryRoot)) {
      problems.push(`${patch} 的 workspaceRoot=${workspaceRoot ?? '(缺席)'} ≠ 它自己的 memoryRoot ⇒ 蒸馏会话写记忆目录会 fence、夜里第一件事是提权卡（ME8 前提破产）`)
    }
  }
}

/** 端口占用要在起进程之前判：撞上了不是报错，是第二个进程静默起着、观测读到别人的现场。 */
function portFree(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.once('connect', () => { socket.destroy(); resolve(false) })
    socket.once('error', () => { socket.destroy(); resolve(true) })
  })
}

const planned = [
  {
    role: 'member',
    port: MEMBER_PORT,
    patches: memberPatches,
    log: path.join(SPIKE, 'step6-member.log'),
    pid: path.join(SPIKE, 'step6-member.pid'),
    url: path.join(SPIKE, 'step6-member.url'),
  },
  {
    role: 'distill',
    port: DISTILL_PORT,
    patches: distillPatches,
    log: path.join(SPIKE, 'step6-distill.log'),
    pid: path.join(SPIKE, 'step6-distill.pid'),
    url: path.join(SPIKE, 'step6-distill.url'),
    // F-6A：蒸馏进程跑在自己的 DSH_HOME 里 ⇒ 它的 schedule.json 与成员那份物理分离。
    env: { ...process.env, DSH_HOME: DISTILL_HOME },
  },
]

for (const item of planned) {
  for (const patch of item.patches) {
    if (!fs.existsSync(path.join(PLATFORM, patch))) problems.push(`${item.role} 的挂载件不存在：${patch}`)
  }
  if (item.port === 3081) problems.push(`${item.role} 端口给了 3081 —— 那是自用验收那台实例，不抢`)
  checkSharedMemoryDir(item.role, item.patches)
}
if (!fs.existsSync(path.join(MEMORY, 'MEMORY.md'))) {
  problems.push(`${MEMORY} 里没有 MEMORY.md ⇒ 先跑 node .spike/seed-distill.mjs`)
} else if (fs.existsSync(path.join(MEMORY, '.seed-expect.json'))) {
  notes.push('种子旁证在场（.seed-expect.json）')
} else {
  problems.push('记忆目录里认不出手改靶 ⇒ 先跑 node .spike/seed-distill.mjs 并用 .spike/check-seed.ts 自检')
}

if (problems.length === 0) checkSeed()

// 武装标记**在场不是故障**，但那一夜「顶层会话出生→武装」这个事件就观测不到了，必须说清。
const armedPath = path.join(MEMORY, 'daily/.distill-armed')
if (fs.existsSync(armedPath)) {
  notes.push(`⚠️ daily/.distill-armed 已存在（${fs.readFileSync(armedPath, 'utf8').trim()}）⇒ 本次看不到武装；想看就重新种种子`)
} else {
  notes.push('daily/.distill-armed 缺席（武装是待观测事件，正确起手态）')
}

// 第 3 枪（成员做一件工作区外的事 ⇒ 该出卡还出卡）要的是成员进程的沙箱真的 fence。成员那份挂载件没钉
// `mode`，写的是 `!!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`（见 `dump-step6-member-compose.log:137-141`），
// 值来自启动器继承的环境 ⇒ 这一层判得了的只有自己看得见的那部分。设成 `danger-full-access` 会让工作区外的写
// **不出卡**，双侧验收的那一半当场观测不到，所以按拒起处理而不是 warning。
const permissionMode = process.env.DSH_PERMISSION_MODE ?? ''
if (permissionMode !== '' && permissionMode !== 'workspace-write') {
  problems.push(`DSH_PERMISSION_MODE=${permissionMode} ⇒ 成员进程工作区外的写可能不 fence、不出卡（第 3 枪没处观测）；请 unset 或改为 workspace-write 再来`)
} else if (permissionMode === '') {
  notes.push('DSH_PERMISSION_MODE 未设 ⇒ 成员侧走默认 workspace-write（内核若从它自己的 env 文件另设过，这一层预检看不见，第 3 枪前在会话权限里确认一次）')
} else {
  notes.push('DSH_PERMISSION_MODE=workspace-write ⇒ 成员侧 fence 在场，第 3 枪可观测')
}

const freePorts = await Promise.all(planned.map(item => portFree(item.port)))
planned.forEach((item, index) => {
  if (!freePorts[index]) problems.push(`端口 ${String(item.port)} 已被占用（${item.role}）—— 先确认是不是上一轮的实例还活着`)
})

for (const line of notes) console.log(`  · ${line}`)
if (problems.length > 0) {
  for (const line of problems) console.error(`  × ${line}`)
  console.error('预检未过 ⇒ 一个进程都没起（这正是预检的意义：省掉两个白等的冷启动）')
  process.exit(1)
}

// F-6A：起进程之前（重）建蒸馏进程的独立 DSH_HOME。不读凭据内容 —— 文件走硬链接、目录走 junction；
// 唯一独立的是 `storages/`，于是两边各写各的 `schedule.json`，谁也不再抹掉/堆叠对方的 nightly 行。
// 只在真起进程时建（`--dry-run` 保持零副作用）。
if (!DRY_RUN) {
  try {
    const linked = ensureDistillHome(DISTILL_HOME)
    console.log(`  · 蒸馏独立 DSH_HOME 已就绪（${DISTILL_HOME}）：${String(linked.length)} 个共享引用 + 独立 storages/`)
  } catch (error) {
    console.error(`  × 建蒸馏独立 DSH_HOME 失败（${DISTILL_HOME}）：${String(error)}`)
    console.error('预检未过 ⇒ 一个进程都没起')
    process.exit(1)
  }
}

for (const item of planned) {
  const args = ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web']
  for (const patch of item.patches) args.push('--patch', path.join(PLATFORM, patch))
  // `./office.patch.yml` 与那份 overlay 都相对内核仓库根解析，顺序照 `boot-step3.mjs` 的实测排列。
  args.push('--patch', './office.patch.yml', '--patch', 'apps/web/tests/pin-browse-picker.overlay.yml')
  args.push('--no-open', '--port', String(item.port))
  // 打印**真正会执行**的、可整行复制的命令：可执行文件取 `process.execPath`（内核根下没有 `node` 那个文件，
  // 拼成 `<KERNEL>\node` 会让照抄的人撞「找不到命令」），含空格的参数加引号（本仓库路径就带空格）。
  const shellArgs = args.map(arg => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ')
  console.log(`\n[${item.role}] cwd=${KERNEL}\n  "${process.execPath}" ${shellArgs}`)
  if (DRY_RUN) continue

  const out = fs.openSync(item.log, 'w')
  const child = spawn(process.execPath, args, {
    cwd: KERNEL,
    stdio: ['ignore', out, out],
    detached: true,
    env: item.env ?? process.env,
  })
  child.unref()
  fs.writeFileSync(item.pid, `${String(child.pid)}\n`, 'utf8')
  item.child = child
}

if (DRY_RUN) {
  console.log('\n--dry-run：预检通过、命令已打印，**没有起任何进程**。')
  process.exit(0)
}

/** 就绪 = 日志里出现该端口的带 token URL（web 开始监听之后才打这行）；URL 含 token，只落 `.spike/*.url`，不回显。 */
const ANSI = new RegExp('\u001B\\[[0-9;]*m', 'g')
function urlFrom(logFile, port) {
  const text = fs.readFileSync(logFile, 'utf8').replace(ANSI, '')
  const urls = text.match(new RegExp(`http://127\\.0\\.0\\.1:${String(port)}/\\S+`, 'g')) ?? []
  return urls.length === 0 ? '' : urls[urls.length - 1].replace(/[.,)]+$/, '')
}

const probe = port => new Promise(resolve => {
  const req = http.get({ host: '127.0.0.1', port, path: CALLBACK, timeout: 2000 }, res => {
    res.resume()
    resolve(res.statusCode)
  })
  req.on('error', () => resolve(0))
  req.on('timeout', () => { req.destroy(); resolve('TIMEOUT') })
})

const deadline = Date.now() + 300_000
const ready = {}
while (Date.now() < deadline && planned.every(item => !ready[item.role])) {
  for (const item of planned) {
    if (ready[item.role]) continue
    if (fs.existsSync(item.log) && urlFrom(item.log, item.port) !== '') ready[item.role] = true
  }
  await new Promise(r => setTimeout(r, 4000))
}

for (const item of planned) {
  if (!ready[item.role]) {
    console.error(`[${item.role}] 300s 内没等到就绪（日志 ${item.log}）—— pid=${String(item.child.pid)}，看日志再决定杀不杀`)
    process.exit(1)
  }
  fs.writeFileSync(item.url, `${urlFrom(item.log, item.port)}\n`, 'utf8')
}

const memberStatus = await probe(MEMBER_PORT)
const distillStatus = await probe(DISTILL_PORT)
console.log(`[member]  ${CALLBACK} → ${String(memberStatus)}（期望 405：路由在场且只收 POST）`)
console.log(`[distill] ${CALLBACK} → ${String(distillStatus)}（期望**不是** 405：这一侧根本没挂 approval）`)
if (memberStatus !== 405) {
  console.error('成员进程没挂上审批路由 ⇒ 双侧验收的「该问的还问」这一半无从观测')
  process.exit(1)
}
if (distillStatus === 405) {
  console.error('蒸馏进程回答了 405 ⇒ approval 被挂进来了，ME8 的构造性前提破产 ⇒ 杀掉，别跑这一夜')
  for (const item of planned) item.child.kill('SIGTERM')
  process.exit(1)
}

// 基线算法本身住在 `step6-baseline.mjs`（与 `.spike/selftest-step6-baseline.ts` 共用同一份生产者），
// 这里只补上只有启动器知道的两个进程字段。
const baseline = {
  ...buildBaseline({ memoryDir: MEMORY, requestsDir: LEDGER_REQUESTS, runsDir: MEMORY_RUN }),
  ports: { member: MEMBER_PORT, distill: DISTILL_PORT },
  pids: { member: fs.readFileSync(planned[0].pid, 'utf8').trim(), distill: fs.readFileSync(planned[1].pid, 'utf8').trim() },
}
fs.writeFileSync(path.join(SPIKE, 'step6-baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')

console.log(`\n两进程就绪：member pid=${baseline.pids.member} distill pid=${baseline.pids.distill}`)
console.log('带 token 的 URL 已写入 .spike/step6-member.url 与 .spike/step6-distill.url（含 token，未回显）')
console.log(`基线 .spike/step6-baseline.json：requests=${String(baseline.ledgerRequests)} office_memory_run=${String(baseline.memoryRunRecords)} MEMORY.md sha=${baseline.memoryMdSha256.slice(0, 12)}… 手改靶 ${baseline.handEditedTarget} 正文 sha=${baseline.handEditedBodySha256.slice(0, 12)}…`)
console.log('\n接下来本人在场要打的三枪：')
console.log('  0) 先向**蒸馏进程**开一个顶层会话 —— 不建会话 ⇒ `daily/.distill-armed` 永远缺席、nightly 不会被武装，而这一夜看起来一切正常')
console.log('  1) 成员会话里 memory_write(kind=daily) ⇒ 只有 daily 变，MEMORY.md 的 sha 不变（ME10 单写者）')
console.log('  2) 成员会话里做一件工作区外的事 ⇒ 该出卡还出卡（requests 多出的**文件名**逐个列名，早上 `verify-step6.ts --cards-expected 1` 就判这张），蒸馏那一侧整夜不动（ME8）')
console.log('  3) 蒸馏会话触发 memory_distill ⇒ MEMORY.md 整段重建（悬空行消失）、水位线前移、手改靶正文 sha 一字不动（V2）、第二次调用 no-op（DM8）')
