/**
 * 记忆层 §7 第 6 步「起手基线」的**唯一生产者**：`.spike/run-step6.mjs` 在起完两个进程后调它落
 * `step6-baseline.json`，`.spike/verify-step6.ts` 早上拿这份 JSON 做差算判定。
 *
 * 为什么要从启动器里抽出来：基线是这一对文件的**契约**，而它此前从来没被端到端跑过 —— 启动器只在真起
 * 两个进程（需本人在场）时才写基线，判据机的自证则自己手搓一份基线对象喂进去。两边各写一遍同一段
 * 算法，就各漂各的：实测抽出来时就抓到两处（手改靶路径被写死、`daily/.watermark` 缺文件时启动器直接
 * ENOENT 崩），而这类漂移的代价是**整夜观测白跑**（判定把「还没发生」读成「被违反」，或反过来）。
 * 抽成一份之后，`selftest-step6-baseline.ts` 能用启动器**同一套表达式**造基线，再喂给判据机验契约。
 *
 * 三条承重的口径，都由消费端 `verify-step6.ts` 的比较方式反推出来，不是随手选的：
 * - **哈希基准 = 文件字节**。消费端算 `sha256(readFileSync(f,'utf8'))`；UTF-8 合法的文本文件两种基准
 *   同值，但基线必须在**起进程那一刻**就能对上，所以这里明确取字节（读不到返回空串，让对应判定自己变红，
 *   而不是让启动器崩在冷启动之后）。
 * - **手改靶路径来自 `.seed-expect.json` 的 `handEditedEntries[0]`** —— 消费端就是按它解析目标的；
 *   写死路径会在换种子（靶改名/加第二个靶）时悄悄哈希错文件。
 * - **`dailyDays` 去掉 `.md` 后缀**（消费端用 `store.listDailyDays()`，它返回 `YYYY-MM-DD`）。
 *   留后缀 ⇒ 集合差永远「新增了整个清单」⇒ DM7 那条判定在起手态就假绿。
 *
 * 只读**文件名与哈希**，绝不读台账正文（`requests/` 在 `.dsh` 下，里面是 argsSnapshot）。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** storage-json 的 per-record 落盘是 `<domain>/<table>/<id>.json`；这里只要**名字清单**，不要正文。 */
export function listJsonNames(dir) {
  try {
    return fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort()
  } catch {
    return []
  }
}

/** 字节基准的 sha256；读不到（缺文件）返回空串，让消费端那条判定自己判红。 */
export function sha256File(file) {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return ''
  }
}

/** 日级清单（无 `.md` 后缀、升序），与 `MemoryStore.listDailyDays()` 同形。 */
export function listDailyDays(memoryDir) {
  try {
    return fs.readdirSync(path.join(memoryDir, 'daily'))
      .filter(name => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      .map(name => name.slice(0, 10))
      .sort()
  } catch {
    return []
  }
}

/**
 * 水位线：只认 `{lastDistilledAt:number, lastDay:string}` 这一种形状（`store.writeWatermark` 写的就是它）。
 * 缺文件 / 坏 JSON / 形状不对都返回 `null` 而不是抛 —— 启动器要的是「预检说清缺什么」，不是冷启动之后一段栈。
 */
export function readWatermark(memoryDir) {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(memoryDir, 'daily/.watermark'), 'utf8'))
  } catch {
    return null
  }
  const ok = typeof parsed.lastDistilledAt === 'number' && typeof parsed.lastDay === 'string'
  return ok ? { lastDistilledAt: parsed.lastDistilledAt, lastDay: parsed.lastDay } : null
}

/** 消费端认的第一个手改靶；种子没给旁证就退回经典那个路径（与 `verify-step6.ts` 的缺省一致）。 */
export function handEditedTarget(memoryDir) {
  try {
    const expect = JSON.parse(fs.readFileSync(path.join(memoryDir, '.seed-expect.json'), 'utf8'))
    const first = (expect.handEditedEntries ?? [])[0]
    return typeof first === 'string' && first !== '' ? first : 'reference/hand-edited-guard.md'
  } catch {
    return 'reference/hand-edited-guard.md'
  }
}

/**
 * 起手基线。`requestsDir` / `runsDir` 由调用方显式传入（启动器传 `.dsh` 下那两个明确路径，
 * 自证传临时目录），这样「读哪张表的哪个目录」永远写在调用处。
 */
export function buildBaseline({ memoryDir, requestsDir, runsDir, takenAt = new Date().toISOString() }) {
  const ledgerRequestFiles = listJsonNames(requestsDir)
  const memoryRunFiles = listJsonNames(runsDir)
  const handEdited = handEditedTarget(memoryDir)
  return {
    takenAt,
    ledgerRequests: ledgerRequestFiles.length,
    memoryRunRecords: memoryRunFiles.length,
    // 名字（不含正文）让「新增了几条」算得准确：计数相同但内容换了也能看出来；正文里带 argsSnapshot，不转储。
    ledgerRequestFiles,
    memoryRunFiles,
    dailyDays: listDailyDays(memoryDir),
    watermark: readWatermark(memoryDir),
    armedMarkerAtStart: fs.existsSync(path.join(memoryDir, 'daily/.distill-armed')),
    memoryMdSha256: sha256File(path.join(memoryDir, 'MEMORY.md')),
    handEditedTarget: handEdited,
    handEditedBodySha256: sha256File(path.join(memoryDir, handEdited)),
  }
}
