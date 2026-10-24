/**
 * 首页 hero 文案的品牌化覆盖层。
 *
 * ## 为什么需要
 *
 * 新建会话时首页显示内核默认的「**探索未至之境** · 预览版」——DeepSeek 官方的产品口号与
 * 「预览版」徽章，与本产品无关。之前用的是**应急 B 方案**：直接改构建产物
 * `packages/client/ui-conversation/lib/client.js`，内核一重建就丢（交接 §3 记着这条）。
 *
 * ## 为什么只能改源码
 *
 * hero 区域只声明了三个槽位（`conversation.hero.brand.mark` / `.workspace` / `.agentPreset`），
 * **没有承载标题文案的槽位** ⇒ 文案只能落到 `locales.ts` 的 `hero.headline` 与 `hero.preview`。
 * 而 `lib/client.js` 会被 client bundle 整份重写，所以改产物不可持续。
 *
 * ## ⚠️ 2026-10-24 事故与本题的解法定型
 *
 * 第一版用「行级 retarget」（`findIndex` 找 `export const zh` / `const en`，再在区间内按正则改行）。
 * `pkg-24` 的 CI 上它把 15 行改成了目标值、文件从 754 行涨到 2750+ 行，随后
 * `apply-data-isolation-build.mjs` 的锚点查找跟着失败。
 *
 * 根因：**行区间 + 正则**这套写法对输入形态做了隐含假设（「只有一个 zh 块、一个 en 块、
 * 键各出现一次」）。一旦 CI 上的文件形态与本地不同（例如被别的步骤写过），它不会报错，
 * 只会**改错地方并继续写**。
 *
 * ⇒ 现在的写法：**先断言唯一性，再做精确子串替换**。不满足前提就**直接抛错**，
 *   宁可让 CI 红在一次明确的诊断上，也不要产出一个被写坏的内核树。
 *
 * 用法（桌面仓根）：node branding/apply-hero-copy.mjs [内核目录=deepseek-harness]
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const kernelRoot = resolve(process.argv[2] ?? 'deepseek-harness')
const conversation = join(kernelRoot, 'packages', 'client', 'ui-conversation')
const localesPath = join(conversation, 'src', 'client', 'locales.ts')
const heroPath = join(conversation, 'src', 'client', 'skeleton', 'EmptyHero.tsx')
const specPath = join(conversation, 'tests', 'skeleton.client.spec.tsx')

/**
 * 要改的文案：`旧串 → 新串`。**旧串必须在整个文件里唯一出现一次**。
 *
 * 中文口号用产品自己的定位（与登录门禁副标题一致）；「预览版」徽章**清空** ——
 * 它是官方的阶段标记，对我们没有意义，视觉上也很扎眼。
 */
const LOCALES_REWRITES = [
  // zh
  [`  'hero.headline': '探索未至之境',`, `  'hero.headline': '让每个员工都有一位 AI 助手',`],
  [`  'hero.preview': '预览版',`, `  'hero.preview': '',`],
  // en
  [`  'hero.headline': 'Into the Unknown',`, `  'hero.headline': 'An AI assistant for every employee',`],
  [`  'hero.preview': 'Preview',`, `  'hero.preview': '',`],
]

/**
 * 断言每个 `find` 在给定文本里出现的次数，并在期望值不符时抛错。
 * @param text - 被检查的文本。
 * @param expectations - `[子串, 期望次数, 说明]`。
 * @param where - 诊断用的文件路径。
 */
function assertOccurrences(text, expectations, where) {
  for (const [needle, expected, label] of expectations) {
    const actual = text.split(needle).length - 1
    if (actual !== expected) {
      throw new Error(
        `hero copy: ${where} 里 ${label} 出现 ${String(actual)} 次，预期 ${String(expected)} 次。\n`
        + `  这是一个**前提不成立**的信号（文件形态与预期不同）。本脚本拒绝在未知形态上写文件 ——\n`
        + `  上一次这么做（pkg-24）把 locales.ts 从 754 行写成了 2750+ 行，连带破坏了后续构建。\n`
        + `  子串：${JSON.stringify(needle)}`,
      )
    }
  }
}

// ── 1. locales.ts：断言唯一性后精确替换 ───────────────────────────────
const locales = await readFile(localesPath, 'utf8')

assertOccurrences(locales, [
  ['export const zh', 1, '`export const zh` 声明'],
  ['export const en', 1, '`export const en` 声明'],
], localesPath)

let nextLocales = locales
let localesApplied = 0
let localesSkipped = 0
for (const [from, to] of LOCALES_REWRITES) {
  const fromCount = nextLocales.split(from).length - 1
  if (fromCount === 0) {
    if (nextLocales.includes(to)) {
      localesSkipped += 1
      continue
    }
    // 旧串不在、新串也不在 ⇒ 内核改了文案，必须让人看见。
    throw new Error(`hero copy: 找不到待替换文案，且目标文案也不存在。\n  期望旧文案：${JSON.stringify(from)}`)
  }
  if (fromCount !== 1) {
    throw new Error(`hero copy: ${localesPath} 里待替换文案出现 ${String(fromCount)} 次（应为 1 次）：${JSON.stringify(from)}`)
  }
  nextLocales = nextLocales.replace(from, to)
  localesApplied += 1
}

// 写回前的**最后一道护栏**：行数不允许暴涨。正常改动是等行替换，
// 行数应当完全不变；出现任何增长都说明替换越界了。
const beforeLines = locales.split('\n').length
const afterLines = nextLocales.split('\n').length
if (afterLines !== beforeLines) {
  throw new Error(`hero copy: 行数从 ${String(beforeLines)} 变成 ${String(afterLines)} —— 等行替换不该改变行数，拒绝写文件。`)
}

if (localesApplied === 0) {
  console.log('hero copy: locales 已是最新，跳过')
} else {
  await writeFile(localesPath, nextLocales)
  console.log(`hero copy: locales 共改 ${String(localesApplied)} 处（${String(localesSkipped)} 处已是最新）→ ${localesPath}`)
}

// ── 2. 徽章：文案清空后不能再渲染那个空壳 ──────────────────────────────
//
// `.previewBadge` 自带 padding / border / background。文案置空后它仍会画出一个**空心胶囊**
// ——比显示「预览版」更难看。所以在组件里加空值判断。
const heroSource = await readFile(heroPath, 'utf8')
const BADGE_FROM = `            <span className={css.previewBadge}>{t('hero.preview')}</span>`
const BADGE_TO = `            {/* 徽章文案由 branding/apply-hero-copy.mjs 清空；空值时不再画空壳。 */}
            {t('hero.preview') === '' ? null : <span className={css.previewBadge}>{t('hero.preview')}</span>}`

if (heroSource.includes(BADGE_TO)) {
  console.log('hero copy: 徽章条件渲染已是最新，跳过')
} else {
  assertOccurrences(heroSource, [[BADGE_FROM, 1, '徽章渲染行']], heroPath)
  await writeFile(heroPath, heroSource.replace(BADGE_FROM, BADGE_TO))
  console.log(`hero copy: 徽章改为条件渲染 → ${heroPath}`)
}

// ── 3. 内核测试的硬编码文案断言 ────────────────────────────────────────
//
// `skeleton.client.spec.tsx` 直接断言官方文案。文案改了这些断言就必须跟着改 —— 否则它们
// 守的是官方文案，而徽章已清空意味着 `getByText('预览版')` 永远找不到。
//
// ⚠️ 用 `replaceAll`：同一句断言在文件里可能出现多次（`getByText('探索未至之境')` 有 2 处），
// `replace` 只改第一个、剩下的会漏（2026-10-24 实测）。
const SPEC_REWRITES = [
  ["expect(view.getByText('Into the Unknown')).toBeTruthy()", "expect(view.getByText('An AI assistant for every employee')).toBeTruthy()"],
  ["expect(b.view.getByText('探索未至之境')).toBeTruthy()", "expect(b.view.getByText('让每个员工都有一位 AI 助手')).toBeTruthy()"],
  ["expect(b.view.queryByText('探索未至之境')).toBeNull()", "expect(b.view.queryByText('让每个员工都有一位 AI 助手')).toBeNull()"],
  ["expect(view.getByText('Preview')).toBeTruthy()", "expect(view.container.querySelector('.previewBadge')).toBeNull()"],
  ["expect(b.view.getByText('预览版')).toBeTruthy()", "expect(b.view.container.querySelector('[class*=\"previewBadge\"]')).toBeNull()"],
]

let spec = await readFile(specPath, 'utf8')
const specBeforeLines = spec.split('\n').length
let specApplied = 0
for (const [from, to] of SPEC_REWRITES) {
  if (!spec.includes(from)) continue
  specApplied += spec.split(from).length - 1
  spec = spec.replaceAll(from, to)
}
if (spec.split('\n').length !== specBeforeLines) {
  throw new Error(`hero copy: 测试文件行数变化（${String(specBeforeLines)} → ${String(spec.split('\n').length)}），拒绝写文件。`)
}
if (specApplied === 0) {
  console.log('hero copy: 内核测试断言已是最新，跳过')
} else {
  await writeFile(specPath, spec)
  console.log(`hero copy: 内核测试断言改 ${String(specApplied)} 处 → ${specPath}`)
}
