/**
 * 首页 hero 文案的品牌化覆盖层。
 *
 * ## 为什么需要
 *
 * 新建会话时首页显示的是内核默认的「**探索未至之境** · 预览版」——那是 DeepSeek 官方的
 * 产品口号与「预览版」徽章，与本产品无关。之前用的是**应急 B 方案**：直接改内核构建产物
 * `packages/client/ui-conversation/lib/client.js`，**内核一重建就丢**（交接 §3 记着这条）。
 *
 * ## 为什么只能改源码
 *
 * hero 区域只声明了三个槽位（`conversation.hero.brand.mark` / `.workspace` / `.agentPreset`），
 * **没有承载标题文案的槽位** ⇒ 文案无法通过槽位注入，只能落到 `locales.ts` 的两个键上。
 *
 * ## 为什么改源码比改产物可靠
 *
 * 产物 `lib/client.js` 会被内核的 client bundle 步骤**整份重写**，所以改产物不可持续。
 * 改 `src/client/locales.ts` 则跟着源码进下一次构建，且本 overlay 可重放 —— 与
 * `apply-branding.mjs` 同一套做法，内核仓零提交。
 *
 * ## 幂等
 *
 * 用**行级**替换（按 `键` 定位、限定该键的行），不按值判断：\`'hero.preview': ''\` 会在中英
 * 两个字典里都出现，按值判断会把英文那条误判为「已应用」（第一版就这么错过一次）。
 *
 * 用法（桌面仓根）：node branding/apply-hero-copy.mjs [内核目录=deepseek-harness]
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const kernelRoot = resolve(process.argv[2] ?? 'deepseek-harness')
const localesPath = join(kernelRoot, 'packages', 'client', 'ui-conversation', 'src', 'client', 'locales.ts')
const heroPath = join(kernelRoot, 'packages', 'client', 'ui-conversation', 'src', 'client', 'skeleton', 'EmptyHero.tsx')

/**
 * 两个键的目标文案。中英各一份。
 *
 * 中文口号用产品自己的定位（与登录门禁副标题一致）；「预览版」徽章**清空** ——
 * 它是官方的阶段标记，对我们没有意义，视觉上也很扎眼。
 */
const TARGET = {
  zh: {
    'hero.headline': '让每个员工都有一位 AI 助手',
    'hero.preview': '',
  },
  en: {
    'hero.headline': 'An AI assistant for every employee',
    'hero.preview': '',
  },
}

const source = await readFile(localesPath, 'utf8')
const lines = source.split('\n')

/** 中文字典从 `export const zh = {` 到 `export const en = {`，之后是英文。 */
const zhStart = lines.findIndex((line) => line.startsWith('export const zh'))
const enStart = lines.findIndex((line) => line.startsWith('export const en'))
if (zhStart < 0 || enStart < 0) throw new Error(`hero copy: 找不到语言块边界 in ${localesPath}`)

/**
 * 把某一段里某个键的值换成目标值。只动**该键所在的那一行**。
 * @param from - 起始行（含）。
 * @param to - 结束行（不含）。
 * @param dictionary - 该语言的键值目标。
 * @param label - 诊断用。
 * @returns 实际改动的行数。
 */
function retarget(from, to, dictionary, label) {
  let changed = 0
  for (let index = from; index < to; index++) {
    for (const [key, value] of Object.entries(dictionary)) {
      const pattern = new RegExp(`^(\\s*'${key.replaceAll('.', '\\.')}':\\s*)'(?:[^'\\\\]|\\\\.)*'(,?)$`, 'u')
      const match = pattern.exec(lines[index])
      if (match === null) continue
      if (match[0].includes(`: '${value}'`)) continue // 已是目标值
      lines[index] = `${match[1]}'${value}'${match[2]}`
      console.log(`  ${label} 第 ${String(index + 1)} 行：${key} → ${value === '' ? '(空)' : value}`)
      changed += 1
    }
  }
  return changed
}

const zhChanged = retarget(zhStart, enStart, TARGET.zh, 'zh')
const enChanged = retarget(enStart, lines.length, TARGET.en, 'en')

if (zhChanged + enChanged === 0) {
  console.log('hero copy: locales 已是最新，跳过')
} else {
  await writeFile(localesPath, lines.join('\n'))
  console.log(`hero copy: locales 共改 ${String(zhChanged + enChanged)} 行 → ${localesPath}`)
}

// ── 徽章：文案清空后不能再渲染那个空壳 ──────────────────────────────
//
// `previewBadge` 自带 padding / border / background（见 HeroShell.module.css）。文案置空后
// 它仍会画出一个**空心胶囊**——比显示「预览版」更难看。所以在组件里加空值判断。
const heroSource = await readFile(heroPath, 'utf8')
const BADGE_FROM = `            <span className={css.previewBadge}>{t('hero.preview')}</span>`
const BADGE_TO = `            {/* 徽章文案由 branding/apply-hero-copy.mjs 清空；空值时不再画空壳。 */
            }
            {t('hero.preview') === '' ? null : <span className={css.previewBadge}>{t('hero.preview')}</span>}`

if (heroSource.includes(BADGE_TO)) {
  console.log('hero copy: 徽章条件渲染已是最新，跳过')
} else if (heroSource.includes(BADGE_FROM)) {
  await writeFile(heroPath, heroSource.replace(BADGE_FROM, BADGE_TO))
  console.log(`hero copy: 徽章改为条件渲染 → ${heroPath}`)
} else {
  throw new Error(`hero copy: 徽章锚点不匹配 in ${heroPath}（内核版本变了？）`)
}

// ── 内核测试的硬编码文案断言 ────────────────────────────────────────
//
// `skeleton.client.spec.tsx` 里 6 处直接断言官方文案（探索未至之境 / 预览版 /
// Into the Unknown / Preview）。文案改了这些断言就必须跟着改——**否则它们守的是官方文案**，
// 而徽章已清空意味着 `getByText('预览版')` 永远找不到。
//
// 这是一处「测试跟着产品口径走」的改动，不是绕过测试：断言仍在验证 hero 渲染了标题，
// 只是标题换成了本产品的。
const specPath = join(kernelRoot, 'packages', 'client', 'ui-conversation', 'tests', 'skeleton.client.spec.tsx')
const SPEC_REPLACEMENTS = [
  // 标题：断言换成新文案。
  ["expect(view.getByText('Into the Unknown')).toBeTruthy()", "expect(view.getByText('An AI assistant for every employee')).toBeTruthy()"],
  ["expect(b.view.getByText('探索未至之境')).toBeTruthy()", "expect(b.view.getByText('让每个员工都有一位 AI 助手')).toBeTruthy()"],
  ["expect(b.view.queryByText('探索未至之境')).toBeNull()", "expect(b.view.queryByText('让每个员工都有一位 AI 助手')).toBeNull()"],
  // 徽章：文案已清空 ⇒ 不再有可查的文本。改为断言「没有徽章元素」，语义等价（原本验的是
  // 「有徽章」，现在验「没有徽章」——因为产品决定不显示它）。
  ["expect(view.getByText('Preview')).toBeTruthy()", "expect(view.container.querySelector('.previewBadge')).toBeNull()".replace('view', 'view')],
  ["expect(b.view.getByText('预览版')).toBeTruthy()", "expect(b.view.container.querySelector('[class*=\"previewBadge\"]')).toBeNull()"],
]

let specSource = await readFile(specPath, 'utf8')
let specChanged = 0
for (const [from, to] of SPEC_REPLACEMENTS) {
  if (!specSource.includes(from)) continue
  // ⚠️ 用 replaceAll 而不是 replace：同一句断言在文件里可能出现在多个用例中
  // （`getByText('探索未至之境')` 就有两处：551 与 617）。`replace` 只改第一个，
  // 第二处会漏掉，测试仍红。
  const occurrences = specSource.split(from).length - 1
  specSource = specSource.replaceAll(from, to)
  specChanged += occurrences
}
if (specChanged === 0) {
  console.log('hero copy: 内核测试断言已是最新，跳过')
} else {
  await writeFile(specPath, specSource)
  console.log(`hero copy: 内核测试断言改 ${String(specChanged)} 处 → ${specPath}`)
}
