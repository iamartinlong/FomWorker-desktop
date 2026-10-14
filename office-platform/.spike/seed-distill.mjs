/**
 * 记忆层 §7 第 6 步「双进程真观测」的**前置种子**：把两进程共用的记忆目录 `.spike/distill-workspace`
 * 摆成一个有内容、且每条守卫都能被观测到的起始态。
 *
 * 为什么这一步必须有种子而不能直接起进程：`distillOnce` 的第一道闸是水位线幂等（DM8）——
 * 空目录里 `listDailyDays()` 返回 `[]` ⇒ `newDays.length === 0` ⇒ 直接记一条 `no-op` 收工，
 * 索引重建、按分值淘汰、手改保护、对账落账**一个字节都不会动**。也就是说没有种子，观测能看到的
 * 只有「蒸馏跑了一次且什么都没做」，那既证不了 ME2 也证不了 ME10。
 *
 * 刻意**不种** `daily/.distill-armed`：那是「夜间蒸馏已武装」的标记（arm.ts 的幂等依据），
 * 观测要看的正是顶层会话出生后它被写出来、重启后命中它而不重复武装。预先种上等于把要观察的事件
 * 本身抹掉。
 *
 * 每份种子的用途写在下面的数组字面量旁边，观测时对着 `.seed-expect.json` 读，不靠记忆。
 *
 * 用法：
 *   node .spike/seed-distill.mjs            # 小体积种子（5 条目 + 3 日级 + 坏索引 + 水位线）
 *   node .spike/seed-distill.mjs --over-budget  # 再加 210 条新鲜 project 条目，把索引推过
 *                                       # `DEFAULT_BUDGET.maxLines=200`，让「按分值淘汰」与
 *                                       # 「超线但手改的留下」两件事真的发生（guardedSkips ≥ 1）
 *   node .spike/seed-distill.mjs --force     # 目录非空时仍然重建（会连观测产物一起删）
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const flags = new Set(argv.filter(arg => arg.startsWith('--')))
const root = argv.find(arg => !arg.startsWith('--'))
  ?? path.join(String.raw`F:\deepseek\deepseek harness\office-platform`, '.spike/distill-workspace')

// 目录里可能已经躺着上一轮观测的真产物（成员写的 daily、蒸馏重写的 MEMORY.md、归档件）。
// 种子是**破坏性**动作，所以默认拒绝非空目录，必须 `--force` 才继续。
const existing = fs.existsSync(root) ? fs.readdirSync(root) : []
if (existing.length > 0 && !flags.has('--force')) {
  console.error(`${root} 非空（${existing.length} 项）。种子会先整目录删除，可能连带抹掉观测产物。\n`
    + '确认那是可弃的 spike 数据后再加 --force 重跑。')
  process.exit(1)
}

/** 与 `store.normalizeBody` 一字不差：LF、去首部空行、尾部恰好一个 `\n`。哈希算在这个结果上。 */
function normalizeBody(body) {
  return `${body.replace(/\r\n?/g, '\n').replace(/^\n+/, '').replace(/\n+$/, '')}\n`
}

function digest(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 造一个条目文件（形状 = `store.renderEntry`：frontmatter 键序 name/description/type/source/createdAt/bodySha256，
 * 闭合标记后空一行）。`staleHash` 是手改的**唯一**留痕方式：正文照实写，frontmatter 里存的是**改写前**
 * 那份正文的哈希 —— `readEntry.handEdited` 于是为真（ME2 的判据），而蒸馏对它的默认取向是只读。
 */
function entryFile({ type, slug, title, hook, body, source = 'session', createdAt, staleHash = false }) {
  const normalized = normalizeBody(body)
  const storedHash = staleHash ? digest(`${normalized}「手改前另有其文」`) : digest(normalized)
  const front = [
    '---',
    `name: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(hook)}`,
    `type: ${JSON.stringify(type)}`,
    `source: ${JSON.stringify(source)}`,
    `createdAt: ${JSON.stringify(createdAt)}`,
    `bodySha256: ${JSON.stringify(storedHash)}`,
    '---',
  ].join('\n')
  // 闭合标记与正文之间**必须空一行**：`parseEntry` 是 `slice(end + 5)` 之后才剥那一个换行的，
  // 少写一个换行就等于把正文的首字符当作排版吃掉 ⇒ 正文哈希对不上 ⇒ 全目录条目被误判成「手改」，
  // 于是蒸馏一条都不敢撤（ME2 的误报会废掉整条守卫）。`.spike/seed-memory.mjs` 那份种子有同一处偏移，
  // 它只被注入侧读过、没走 `readEntry`，所以当时没暴露。
  return { rel: `${type}/${slug}.md`, text: `${front}\n\n${normalized}` }
}

// `createdAt` 用显式 ISO 串（带 Z）而不是挂钟：种子的年龄必须可复现，否则「按分值淘汰」的
// 边界会随观测当天漂移，`.seed-expect.json` 就成了事后编的。
const FRESH = '2026-10-10T02:00:00.000Z'
const ANCIENT = '2026-05-01T02:00:00.000Z'

const entries = [
  // ① 高分留任：`user` 权重 4 且新鲜。重建后的索引里它必然排在最前 —— ME10 的「整段重写后顺序按分值」看这一条。
  entryFile({
    type: 'user', slug: 'role', source: 'user', createdAt: FRESH,
    title: '用户画像',
    hook: '办公平台的开发接手者，中文沟通，产出要带可复跑证据',
    body: '角色：办公 Agent 平台的开发/接手者。\n偏好：中文；结论要有能复跑的测试或现场观察撑着。',
  }),
  // ② 中分新鲜：`feedback` 权重 3。手改过的**新**条目不在淘汰候选里，这里先给它一个「正常条目」的对照。
  entryFile({
    type: 'feedback', slug: 'no-install-at-root', createdAt: FRESH,
    title: '别在 office-platform 根目录装包',
    hook: '根目录装依赖会塞进第二份内核，跨实例 instanceof 全炸',
    body: '规则：自研根目录永远不装依赖，外部 SDK 装进各自点目录。\n\nWhy: 出现过「绿了半天是两个内核互相看不见」。\nHow to apply: 要加依赖先问能不能 junction 指回主内核。',
  }),
  // ③ 观测中新写的条目要能立刻读回来，所以给它合法 slug 与干净哈希。
  entryFile({
    type: 'project', slug: 'q4-report-revision', createdAt: FRESH,
    title: 'Q4 报告改版',
    hook: '改版由法务口径驱动，不是排版偏好',
    body: '每一处口径改动都要能追到法务的一句话要求。\n\nWhy: 法务要口径全平台一致。\nHow to apply: 先问法务，再动排版。',
  }),
  // ④ 淘汰候选：`reference` 权重 1 且 163 天前出生 ⇒ 分数垫底。只在 --over-budget 下真被归档。
  entryFile({
    type: 'reference', slug: 'legacy-endpoint', createdAt: ANCIENT,
    title: '旧内网报表端点（已下线的 v1）',
    hook: 'v1 报表端点位置，服务已在 2026-06 下线',
    body: '位置：内网 v1 报表服务（已下线）。\n留着的意义：老工单里还能搜到这个 URL。',
  }),
  // ⑤ **手改保护靶**：同样垫底（reference + ANCIENT），但哈希与正文不符 ⇒ `handEdited` 为真。
  //   非手改的 ④ 被撤而它必须留下 ⇒ `guardedSkips === 1`，这就是 ME2「预算与手改冲突时让预算输」的现场证据。
  entryFile({
    type: 'reference', slug: 'hand-edited-guard', staleHash: true, createdAt: ANCIENT,
    title: '人工修订过的部署口述（手改保护靶）',
    hook: '这条由人手补过一句，蒸馏不许撤它也不许改正文',
    body: '原始内容来自一次口述。\n\n人工补充：2026-06 换过机房，这条的口径以人写的为准。\n（这一行让正文与 frontmatter 里存着的旧哈希不一致 —— 这就是「手改」的判据。）',
  }),
]

if (flags.has('--over-budget')) {
  // 210 条新鲜 project 条目把总量推到 215 > `maxLines=200`。哪几条 pad 出局不作为断言（同分并列由
  // 路径字典序定），断言的是计数不变量：`guardedSkips === 1`、⑤ 仍在索引里、④ 已被归档。
  for (let index = 0; index < 210; index += 1) {
    entries.push(entryFile({
      type: 'project', slug: `pad-${String(index).padStart(3, '0')}`, createdAt: FRESH,
      title: `占位条目 ${index}`,
      hook: '只为把索引推过预算线，无长期价值',
      body: `第 ${index} 号占位正文。`,
    }))
  }
}

/** 日级流水：文件名形状由 `store.listDailyDays()` 的正则决定（`YYYY-MM-DD.md`）。 */
function dailyFile(day, lines) {
  return { rel: `daily/${day}.md`, text: `# ${day} 流水\n\n${lines.map(line => `- ${line}`).join('\n')}\n` }
}

// 水位线停在 2026-10-07：于是 `daily/2026-10-07.md` 是「已蒸过」的对照（必须不再被处理），
// 而 10-09 / 10-10 是 `newDays`，让这一夜真的有事可做。
const WATERMARK = { lastDistilledAt: Date.parse('2026-10-08T03:30:00.000Z'), lastDay: '2026-10-07' }

const dailies = [
  dailyFile('2026-10-07', [
    '新增记忆 - [用户画像](user/role.md) — 办公平台的开发接手者，中文沟通，产出要带可复跑证据',
    '这一天已经在水位线之前：本文件里的任何内容都不该被再次提炼成条目（DM8）',
  ]),
  dailyFile('2026-10-09', [
    '新增记忆 - [Q4 报告改版](project/q4-report-revision.md) — 改版由法务口径驱动，不是排版偏好',
    '用户说明天要把周报里「客户流失率」的口径统一成法务给的那句',
    '排查：成员进程用裸 write 写记忆目录会撞 FS_SANDBOX_DENIED，改走 memory_write 即通',
  ]),
  dailyFile('2026-10-10', [
    'Q3 结项：报告改版线并入日常维护，不再单独立项',
    '用户提到内网巡检网关的口令临时写在配置里：ops_password: FAKE-NOT-A-REAL-SECRET-0001',
    '（上面那一行是**假值**，专门用来测 ME6/ME7：蒸馏把它提炼成新条目时必须被黑名单拒记，正文一个字都不许落盘）',
  ]),
]

/**
 * 种一份**故意错**的 `MEMORY.md`（三个观测点各自独立可判）：
 * - 悬空行指向不存在的 `project/ghost-entry.md`：整段重写后它必然消失（ME10「重写而非增量」的硬证据；
 *   增量更新的失败形态恰恰是把悬空行留着）。
 * - 缺 ④⑤ 的行：重建后应当补上（说明索引是从磁盘现算的，不是抄旧索引）。
 * - 带凭据的行：常驻注入段必须整行剔掉并只在日志记数（ME7 注入侧），蒸馏重写时它本就不来自磁盘条目，
 *   所以重写后也必然没有它。
 */
function indexLine(entry) {
  const title = JSON.parse(/^name: (.*)$/m.exec(entry.text)?.[1] ?? '""')
  const hook = JSON.parse(/^description: (.*)$/m.exec(entry.text)?.[1] ?? '""')
  return `- [${title}](${entry.rel}) — ${hook}`
}

const danglingLine = '- [已删掉的占位](project/ghost-entry.md) — 索引里这条链接早就没人了'
const secretLine = '- [内网口令便条](project/internal-note.md) — 直接写着 ops_password: FAKE-NOT-A-REAL-SECRET-0002'
const indexLinesSeeded = [
  indexLine(entries[0]),
  indexLine(entries[1]),
  danglingLine,
  secretLine,
]
const seededIndex = `# 长期记忆索引\n\n${indexLinesSeeded.join('\n')}\n`

fs.rmSync(root, { recursive: true, force: true })
for (const file of [...entries, ...dailies]) {
  const absolute = path.join(root, file.rel)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, file.text, 'utf8')
}
fs.writeFileSync(path.join(root, 'MEMORY.md'), seededIndex, 'utf8')
fs.writeFileSync(path.join(root, 'daily/.watermark'), `${JSON.stringify(WATERMARK)}\n`, 'utf8')

fs.writeFileSync(path.join(root, '.seed-expect.json'), JSON.stringify({
  overBudget: flags.has('--over-budget'),
  entryCount: entries.length,
  watermark: WATERMARK,
  // 水位线之后必须被当作 `newDays` 的日子；`2026-10-07` 不在列（DM8 幂等）。
  newDays: ['2026-10-09', '2026-10-10'],
  ignoredDays: ['2026-10-07'],
  // 手改靶靠「frontmatter 存的哈希 ≠ 正文现算哈希」识别，与 `readEntry.handEdited` 同一判据。
  handEditedEntries: ['reference/hand-edited-guard.md'],
  // 蒸馏收尾的判据（--over-budget 才有淘汰；小种子只断言「一个字节都不该撤」）。
  expected: {
    outcome: 'distilled',
    guardedSkips: flags.has('--over-budget') ? 1 : 0,
    archivedAtLeast: flags.has('--over-budget') ? 1 : 0,
    mustSurviveInIndex: ['user/role.md', 'reference/hand-edited-guard.md'],
    mustVanishFromIndex: ['project/ghost-entry.md'],
    // 凭据靶只记**位置**，不在这里复述字面值：观测收尾要用「整目录搜这个串」来判 ME7 有没有漏，
    // 而 sidecar 自己带着字面值就会永远命中，把检查变成假红。
    // - 磁盘索引里的那一行：`MEMORY.md` 里 `](project/internal-note.md)` 那一行（蒸馏整段重写后必须没有它）。
    // - 日级流水里的那一行：`daily/2026-10-10.md` 里含 `ops_password:` 的那一行（提炼成新条目时必须被黑名单拒记）。
    secretTargets: ['MEMORY.md:](project/internal-note.md)', 'daily/2026-10-10.md:ops_password:'],
    // 检查范围要限定在「条目正文 + 重建后的索引」，别把靶子本身（上面两处）算成泄漏。
    secretScanScope: '{user,feedback,project,reference}/*.md + MEMORY.md',
    // 武装标记是**要被观测出来的**，不是被种出来的：起始态必须没有它。
    armedMarkerAtSeed: 'absent',
  },
}, null, 2), 'utf8')

console.log(`seeded ${root}`)
console.log(`  条目 ${entries.length} 条（其中手改靶 1 条：reference/hand-edited-guard.md）`)
console.log(`  日级 ${dailies.map(d => d.rel).join(', ')}；水位线 lastDay=${WATERMARK.lastDay}`)
console.log(`  MEMORY.md 预置 ${indexLinesSeeded.length} 行，含悬空行与凭据行各一`)
console.log(`  daily/.distill-armed：不种（武装是待观测事件）`)
if (!flags.has('--over-budget')) {
  console.log('  提示：要观测「按分值淘汰 + 手改保护」，加 --over-budget 把索引推过 maxLines=200')
}
