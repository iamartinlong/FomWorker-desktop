/**
 * `office-skills` 两个「描述不能漂」的校验——**vitest 跑不了时的替代品**。
 *
 * 背景（踩坑 §2.30 第二次形态）：bundled 技能的 description 在 `index.ts` 的 `SKILLS` 数组里，
 * provider **从不读 frontmatter**；而 managed / platform 两个 provider **只读 frontmatter**
 * ⇒ `assets/<name>/SKILL.md` 里那行长期是**死字段**，改它对界面零影响。
 * 「常量在两处、只有一处在用」比「常量写错」更危险——写错会立刻红，另一份会安静地变成谎言。
 *
 * 主判据在 `plugins/office-skills/index.spec.ts`（遍历 provider 候选 ↔ frontmatter 逐字比）。
 * 本脚本是**同一判据的独立复现**，用于本机没有内核检出、vitest 跑不了的环境；
 * 另外多验一件单测没覆盖的事：**esbuild 产物里那份 description 也是对的**。
 *
 * ⚠️ 为什么必须解码后再比（踩坑 §2.31）：esbuild 默认 `charset=ascii` ⇒ 产物里中文是
 * `\uXXXX` 转义，**直接 grep 中文字串会 0 命中**，看着像没打进去。
 *
 * 用法：node apps/fom-client/scripts/verify/verify-skill-descriptions.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// 本脚本在 apps/fom-client/scripts/verify/ ⇒ 上四级才是仓库根
const repoRoot = join(here, '..', '..', '..', '..')
const plugin = join(repoRoot, 'apps', 'fom-client', 'plugins', 'office-skills')

/** frontmatter 的 name/description（与 managed.ts 的 parseSkillFrontmatter 同款判据）。 */
function parseFrontmatter(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(raw)
  if (match === null) return {}
  const out = {}
  for (const line of match[1].split(/\r?\n/u)) {
    const m = /^(name|description):\s*(.*)$/u.exec(line.trim())
    if (m !== null) out[m[1]] = m[2].trim()
  }
  return out
}

/** 解 JS 字面量：\uXXXX 与常见转义。 */
function decodeLiteral(literal) {
  return literal
    .replace(/\\u([0-9a-fA-F]{4})/gu, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/gu, '\n')
    .replace(/\\"/gu, '"')
    .replace(/\\\\/gu, '\\')
}

const source = readFileSync(join(plugin, 'index.ts'), 'utf8')
const lib = readFileSync(join(plugin, 'lib', 'index.js'), 'utf8')

// 切出 SKILLS 数组块，再按顺序把 name/description 配对（不假设每条之间有几行注释）。
const blockMatch = /const SKILLS = \[([\s\S]*?)\]\s*as const/u.exec(source)
if (blockMatch === null) { console.error('✗ index.ts 里没找到 SKILLS 数组'); process.exit(1) }
const block = blockMatch[1]
const names = [...block.matchAll(/\bname:\s*'([^']+)'/gu)].map(([, v]) => v)
const descriptions = [...block.matchAll(/\bdescription:\s*'([^']+)'/gu)].map(([, v]) => v)
if (names.length !== descriptions.length) {
  console.error(`✗ SKILLS 块里 name(${names.length}) 与 description(${descriptions.length}) 数量不等`)
  process.exit(1)
}

let failed = 0
const check = (ok, label, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || detail === undefined ? '' : '\n    ' + detail}`)
  if (!ok) failed += 1
}

console.log(`SKILLS 解析出 ${names.length} 条：${names.join(', ')}\n`)

for (let i = 0; i < names.length; i += 1) {
  const name = names[i]
  const fromCode = descriptions[i]

  // ① frontmatter 与代码常量逐字相等
  const raw = readFileSync(join(plugin, 'assets', name, 'SKILL.md'), 'utf8')
  const fromFrontmatter = parseFrontmatter(raw).description
  check(fromFrontmatter === fromCode, `${name}：frontmatter ↔ index.ts 逐字一致（${fromCode.length} 字）`,
    `index.ts   : ${fromCode}\nfrontmatter: ${fromFrontmatter ?? '(缺失)'}`)

  // ② 产物里那份也是对的（解 \uXXXX 后比）
  const libMatch = new RegExp(`name:\\s*"${name}",[\\s\\S]*?description:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'u').exec(lib)
  if (libMatch === null) {
    check(false, `${name}：产物 lib/index.js 里找不到该条目`, '重放重建后再来（build-host-halves.mjs）')
    continue
  }
  const decoded = decodeLiteral(libMatch[1])
  check(decoded === fromCode, `${name}：产物 description 解码后一致（字面量 ${libMatch[1].length} 字符 → 解码 ${decoded.length} 字）`,
    `产物解码 : ${decoded}\nindex.ts : ${fromCode}`)

  // ③ slug 合法（作目录名）
  check(/^[a-z0-9][a-z0-9._-]*$/u.test(name), `${name}：slug 合法`)
}

// 顺序（对应 index.spec.ts 里那条 toEqual）
const expected = ['meeting-minutes', 'weekly-report', 'skill-creator']
check(JSON.stringify(names) === JSON.stringify(expected), `SKILLS 顺序 = ${JSON.stringify(names)}`)

console.log(failed === 0 ? '\n✓ 全部通过' : `\n✗ ${failed} 处失败`)
process.exit(failed === 0 ? 0 : 1)
