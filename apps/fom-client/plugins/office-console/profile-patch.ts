/**
 * **平台层连接器配置**的落地（T5b）：把表单值写进**用户自己的 profile patch**
 * （`$DSH_HOME/profiles/<profile>/cordis.patch.yml`）。
 *
 * 为什么是 profile patch 而不是别的：bundle patch（`apps/fom-client/bundle/cordis.patch.yml`）
 * 是**随包发布的产品默认值**，改它要重新打包；而内核的层级是
 * 「每个 bundle 层 → `cordis.patch.yml`（用户层）→ `--patch` 覆盖」
 * （`cordis.yml` 头部注释逐字这么写）⇒ **用户层就是给「这台机器想改默认值」用的**，
 * 且它本来就已经在用了（上面那份 StepFun 提供商配置就是 UI 写进去的）。
 *
 * **不引 YAML 解析器**（仓里零依赖纪律）：本模块只做两种事——
 * ① `renderPatchEntry()` **生成**一条 patch 条目（复用 `connector-bundle.ts 的标量规则）；
 * ② `upsertPatchEntry()` 用**文本手术**把它并进现有文件：
 *    - 文件里没有同 `id` 条目 ⇒ 追加到数组末尾；
 *    - 已有同 `id` 条目 ⇒ 整条替换（从 `- id: <id>` 到下一个 `- id:` 或文件尾）。
 *    替换按**行边界**做，不动别人的条目——这是纯文本层面能做到的最强保证。
 *
 * ⚠️ 已知限制（写进注释，别假装没有）：文本手术认的是「`- id:` 开头的行」。
 * 用户若在 patch 里写了**多行字符串值**且其中某行恰好以 `- id:` 开头，会误判边界。
 * 概率极低（patch 是机器写的），但真出现时症状是「我的配置把别人的条目吃掉一半」——
 * 所以 `upsertPatchEntry()` 返回**改前改后的条目数**，调用方发现条数变少就报错回落。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** 标量 YAML 表示（与 `connector-bundle.ts` 同一套规则；不跨文件抽公共模块是为避免循环依赖）。 */
function yamlScalar(value: string): string {
  const needsQuote = value === ''
    || /^[-+]?\d+(\.\d+)?$/u.test(value)
    || /^(true|false|yes|no|on|off|null|~)$/iu.test(value)
    || /^\s|\s$/u.test(value)
    || /:\s|\s#|:$/u.test(value)
    || /[,\{}\[\]]/u.test(value)
    || /^[-?!&*|>%@`"']/u.test(value)
  if (!needsQuote) return value
  return `'${value.replace(/'/gu, "''")}'`
}

function yamlValue(key: string, value: unknown): string {
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === 'string')
    return items.length === 0 ? '[]' : `[${items.map(yamlScalar).join(', ')}]`
  }
  if (typeof value === 'object' && value !== null) {
    const pairs = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'string')
      .map(([k, v]) => `${k}: ${yamlScalar(v as string)}`)
    return pairs.length === 0 ? '{}' : `{${pairs.join(', ')}}`
  }
  const text = typeof value === 'string' ? value : String(value)
  return /^\d+$/u.test(text) && (key === 'toolCallTimeoutMs' || key === 'maxInstructionBytes')
    ? text
    : yamlScalar(text)
}

/**
 * 生成一条 patch 条目（`- id: …` 起头，含 `name` 与 `config`）。
 * @param id - 条目 id（如 `office-feishu`）。
 * @param name - 插件名（如 `@office/feishu`）。
 * @param config - 配置键值。
 * @returns YAML 文本（以换行结尾，不含前导空行）。
 */
export function renderPatchEntry(id: string, name: string, config: Readonly<Record<string, unknown>>): string {
  const lines = [`- id: ${id}`, `  name: '${name}'`, '  config:']
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined) continue
    lines.push(`    ${key}: ${yamlValue(key, value)}`)
  }
  return `${lines.join('\n')}\n`
}

/** 一条 patch 条目的边界（起止行，含起不含止）。 */
interface EntrySpan {
  readonly start: number
  readonly end: number
}

/**
 * 在 patch 文本里找某 `id` 的条目边界（按 `- id:` 开头的行切段）。
 * @param text - patch 全文。
 * @param id - 目标 id。
 * @returns 边界；不存在 ⇒ `undefined`。
 */
export function findEntrySpan(text: string, id: string): EntrySpan | undefined {
  const lines = text.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const m = /^- id:\s*'?([^'\s]+)'?\s*$/u.exec(line)
    if (m === null) continue
    if (start >= 0) return { start, end: i }
    if (m[1] === id) start = i
  }
  return start >= 0 ? { start, end: lines.length } : undefined
}

/** 数一下 patch 里有几条 `- id:` 条目（手术前后对账用）。 */
export function countEntries(text: string): number {
  return text.split('\n').filter((line) => /^- id:\s*'?[^'\s]+'?\s*$/u.test(line)).length
}

/**
 * 把一条 patch 条目并进现有 patch 文本（没有则追加，有则整条替换）。
 *
 * @param text - 现有 patch 全文。
 * @param id - 条目 id。
 * @param entry - 新条目 YAML（`renderPatchEntry()` 的产物）。
 * @returns 新全文；**条数变少时抛**（说明文本手术误判了边界，宁可不写也别吃别人的条目）。
 */
export function upsertPatchEntry(text: string, id: string, entry: string): string {
  const before = countEntries(text)
  const span = findEntrySpan(text, id)
  const lines = text.split('\n')
  let next: string[]
  if (span === undefined) {
    // 追加：保证前面有空行分隔（除非文件本来就没内容）
    const trimmed = text.replace(/\s+$/u, '')
    next = trimmed === '' ? [entry.trimEnd()] : [`${trimmed}`, '', entry.trimEnd(), '']
  } else {
    const entryLines = entry.trimEnd().split('\n')
    next = [...lines.slice(0, span.start), ...entryLines, ...lines.slice(span.end)]
  }
  const result = next.join('\n')
  if (countEntries(result) < before) {
    throw new Error(`patch 手术异常：条目数 ${before} → ${countEntries(result)}（疑似误判边界，已放弃写入）`)
  }
  return result
}

/**
 * profile patch 文件路径。
 * @param home - Harness home。
 * @param profile - profile 名（缺省 `desktop`）。
 */
export function profilePatchPath(home: string, profile = 'desktop'): string {
  return join(home, 'profiles', profile, 'cordis.patch.yml')
}

/** 读 profile patch（不存在 ⇒ 空串）。 */
export function readProfilePatch(path: string): string {
  if (!existsSync(path)) return ''
  return readFileSync(path, 'utf8')
}

/** 写 profile patch（整份覆盖，自动建父目录）。 */
export function writeProfilePatch(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** `$DSH_HOME` 解析（与内核同口径）。 */
export function resolveDshHome(): string {
  const home = process.env.DSH_HOME
  return home !== undefined && home !== '' ? home : join(homedir(), '.dsh')
}
