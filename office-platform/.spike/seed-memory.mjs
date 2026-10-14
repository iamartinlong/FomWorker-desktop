/**
 * 记忆层 §7 第 3 步真进程观察的**种子**：往一个空记忆目录里放好一张 `MEMORY.md` 索引 + 对应条目文件。
 *
 * 为什么这一步要手工种索引，而不是让模型 `memory_write` 出来：
 *   `memory_write` 只写 `{type}/{slug}.md` 并往**当天流水**留一行线索，它**不碰 MEMORY.md**
 *   （ME10 单一写者；整段重建索引是第 5 步夜间蒸馏的活）。所以第 3 步想验证的「常驻索引段会不会进
 *   模型提示词」，此刻能进段的内容只有磁盘上的 MEMORY.md —— 它代表的是「蒸馏已经把索引写好了」这个
 *   第 3 步之后的稳态。手工种它，就是把观察对准注入那一半，不越步去假装蒸馏已经跑过。
 *
 * 种子里**故意放一行带凭据的**：注入侧黑名单（ME7）必须把它从段里剔掉、且只在流水记数不记原文。
 * 这一行不写进条目文件也没关系 —— 判据看的是「段里有没有它」，不是「条目在不在」。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const root = process.argv[2]
  ?? path.join(String.raw`F:\deepseek\deepseek harness\office-platform`, '.spike/memory-step3')

function digest(body) {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

// 条目正文存的是「规范化后」的形态：尾部恰好一个换行，哈希才算得对（store.normalizeBody 同规则）。
function entryFile({ type, slug, title, hook, body, source = 'session', createdAt = '2026-10-08T09:00:00' }) {
  const normalized = `${body.replace(/\r\n?/g, '\n').replace(/^\n+/, '').replace(/\n+$/, '')}\n`
  const front = [
    '---',
    `name: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(hook)}`,
    `type: ${JSON.stringify(type)}`,
    `source: ${JSON.stringify(source)}`,
    `createdAt: ${JSON.stringify(createdAt)}`,
    `bodySha256: ${JSON.stringify(digest(normalized))}`,
    '---',
  ].join('\n')
  // 闭合标记后必须空一行：`store.parseEntry` 是 `slice(end + 5)` 之后才剥那一个换行的，少一个换行
  // 等于吃掉正文首字符 ⇒ `handEdited` 对每条都为真。第 3 步只经注入段读过这份种子（不走 `readEntry`），
  // 所以当时没暴露；同一处偏移在 `.spike/seed-distill.mjs` 里由 `.spike/check-seed.ts` 抓出并修正。
  return { rel: path.posix.join(type, `${slug}.md`), text: `${front}\n\n${normalized}` }
}

const entries = [
  entryFile({
    type: 'user', slug: 'role',
    title: '用户画像',
    hook: '我是这个办公平台的开发接手者，中文沟通，要带证据、可动手落地的产出',
    body: '角色：办公 Agent 平台的开发/接手者。\n偏好：中文；结论要有能复跑的测试或现场观察撑着，不要空泛。',
    source: 'user',
  }),
  entryFile({
    type: 'project', slug: 'report-revision',
    title: 'Q4 报告改版',
    hook: 'Q4 报告改版由法务口径驱动，不是排版偏好',
    body: '改版动的每一处口径都要能追到法务的一句话要求。\n\nWhy: 法务要口径全平台一致。\nHow to apply: 先问法务，再动排版。',
  }),
  entryFile({
    type: 'feedback', slug: 'no-pnpm-install',
    title: '别在 office-platform 根目录装包',
    hook: '在自研根目录 pnpm install 会悄悄塞进第二份内核，跨实例 instanceof 与服务键全炸',
    body: '规则：office-platform 根目录永远不装依赖，外部 SDK 装进各自的点目录（如 .spike/feishu-ws/node_modules）。\n\nWhy: 出现过一次「绿了半天，是两个内核在互相看不见」。\nHow to apply: 要加依赖先问能不能用 junction 指回主内核。',
    source: 'session',
  }),
]

// 索引里额外挂一条**带凭据**的行（ME7 注入侧的靶子）：模型段里不许出现它，流水里只许出现计数。
const secretLine = '- [内网令牌](project/internal-token.md) — 鉴权用 x-access-token: abcdef0123456789 直接贴这里'

// 直接用条目文件里已有的 title/hook/rel 生成索引行，保证与 store 的 indexLineFor 一字不差。
function indexLine(e) {
  const title = /^name: (.*)$/m.exec(e.text)?.[1]
  const hook = /^description: (.*)$/m.exec(e.text)?.[1]
  const parse = s => JSON.parse(s)
  return `- [${parse(title)}](${e.rel.replace(/\\/g, '/')}) — ${parse(hook)}`
}

const memoryMd = [
  '# 长期记忆索引',
  '',
  ...entries.map(indexLine),
  secretLine,
  '',
].join('\n')

fs.rmSync(root, { recursive: true, force: true })
for (const e of entries) {
  const abs = path.join(root, e.rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, e.text, 'utf8')
}
fs.writeFileSync(path.join(root, 'MEMORY.md'), memoryMd, 'utf8')

// 把「哪几行该进段、哪一行该被剔」写成一个旁证文件，观察时对着读，别靠记忆。
fs.writeFileSync(path.join(root, '.seed-expect.json'), JSON.stringify({
  shouldInject: entries.map(indexLine),
  shouldDeny: [secretLine],
  entryFiles: entries.map(e => e.rel.replace(/\\/g, '/')),
}, null, 2), 'utf8')

console.log(`seeded ${path.join(root, 'MEMORY.md')}`)
console.log(`  条目：${entries.map(e => e.rel.replace(/\\/g, '/')).join(', ')}`)
console.log(`  越界行（应被注入侧剔除）：${secretLine}`)
