/**
 * 种子自检：用**真实代码**（`store.ts` / `distill.ts` / `inject.ts`）读一遍 `seed-distill.mjs`
 * 摆出来的目录，确认观测起手态确实是「每条守卫都有靶子、且没有一条被误伤」。
 *
 * 为什么要有这一步而不是肉眼 cat 文件：种子的价值全在「与实现层的磁盘形状一字不差」。
 * `parseEntry` 用 `slice(end + 5)` 跳过闭合标记后那一个换行 —— 少种一个换行会把正文首字符吃掉，
 * 于是 `handEdited` 对**每一条**都为真，ME2 的误报会让蒸馏一条都不敢撤，观测看到的就是假绿。
 * 这类形状错肉眼看不出来，只能让真代码读一遍。
 *
 * 跑法（`--import tsx/esm` 需要内核那份 tsx，所以在仓库根执行；纯读盘，不起产品、不产生模型回合）：
 *   cd ../deepseek-harness && node --import tsx/esm "../office-platform/.spike/check-seed.ts" <seedDir>
 */
import { buildIndexBlock } from '../plugins/office-memory/inject.ts'
import { planDistill, renderIndex } from '../plugins/office-memory/distill.ts'
import { MemoryStore } from '../plugins/office-memory/store.ts'

const root = process.argv[2] ?? ''
if (root === '') {
  console.error('用法：node --import tsx/esm .spike/check-seed.ts <seedDir>')
  process.exit(2)
}

// 观测当天的挂钟：种子里的 `createdAt` 是写死的 ISO 串，所以分数与淘汰边界必须对着这个时刻算，
// 不能拿跑自检时的真挂钟 —— 那会随日期漂移，`.seed-expect.json` 就成了事后编的。
const NOW = Date.parse('2026-11-01T03:30:00.000Z')

const store = new MemoryStore(root, { now: () => NOW })
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1
  console.log(`${ok ? '✓' : '×'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

const watermark = await store.readWatermark()
check('水位线读得回来且停在 2026-10-07', watermark?.lastDay === '2026-10-07', JSON.stringify(watermark))

const days = await store.listDailyDays()
const newDays = watermark === undefined ? days : days.filter(day => day > watermark.lastDay)
check('日级枚举只收到 YYYY-MM-DD.md（.watermark 不算日子）',
  days.join(',') === '2026-10-07,2026-10-09,2026-10-10', days.join(','))
check('水位线之后的 newDays 非空 ⇒ 蒸馏不会 no-op 收工',
  newDays.join(',') === '2026-10-09,2026-10-10', newDays.join(','))

const entries = await store.scanEntries()
const handEdited = entries.filter(entry => entry.handEdited).map(entry => entry.relativePath)
check('只有手改靶被判定为 handEdited（其余条目哈希自洽）',
  handEdited.length === 1 && handEdited[0] === 'reference/hand-edited-guard.md',
  `共 ${entries.length} 条，handEdited=${handEdited.join(',') || '无'}`)

const role = await store.readEntry('user/role.md')
check('正文首字符没被排版吃掉（parseEntry 的换行偏移自检）',
  role.body.startsWith('角色：办公 Agent 平台的开发/接手者'), JSON.stringify(role.body.slice(0, 12)))
check('索引行形状与 indexLineFor 一致（重建后可逐行比对）',
  role.indexLine === '- [用户画像](user/role.md) — 办公平台的开发接手者，中文沟通，产出要带可复跑证据',
  role.indexLine)

const armed = await store.readArmedJob()
check('起始态没有武装标记（.distill-armed 是要被观测写出来的，不是种出来的）', armed === undefined,
  String(armed))

const rawIndex = await store.readIndex()
check('种进去的坏索引带着悬空行（观测后它必须消失）',
  rawIndex.includes('](project/ghost-entry.md)'))
const built = buildIndexBlock(rawIndex)
check('注入侧剔掉那一行凭据（ME7），且只记计数不记原文',
  built.deniedCount === 1 && !built.block.includes('FAKE-NOT-A-REAL-SECRET-0002'),
  `deniedCount=${built.deniedCount}, trimmed=${built.trimmed.length}`)

const overBudget = entries.length > 200
const plan = planDistill(entries, { now: NOW })
check(overBudget
  ? '超预算：有淘汰候选，且手改靶被留在 kept 里（ME2 压过 ME1）'
  : '小种子：预算内 ⇒ 零淘汰零跳过（淘汰与手改保护要靠 --over-budget 才发生）',
  overBudget
    ? plan.guardedSkips === 1
      && plan.evictions.length > 0
      && plan.kept.some(e => e.relativePath === 'reference/hand-edited-guard.md')
      && plan.evictions.every(e => !e.handEdited)
    : plan.evictions.length === 0 && plan.guardedSkips === 0,
  `kept=${plan.kept.length} evictions=${plan.evictions.length} guardedSkips=${plan.guardedSkips}`)

const rebuilt = renderIndex(plan.kept)
check('整段重建的索引以标题行开头并按分值降序',
  rebuilt.startsWith('# 长期记忆索引\n\n- [用户画像](user/role.md)')
  && !rebuilt.includes('ghost-entry') && !rebuilt.includes('FAKE-NOT-A-REAL-SECRET-0002'),
  `${rebuilt.split('\n').length} 行`)

console.log(failures === 0 ? `\nPASS ${root}` : `\nFAIL ${failures} 项 ${root}`)
process.exit(failures === 0 ? 0 : 1)
