/**
 * **本地自建目录**（G7「两源」的本地源）：落 `$DSH_HOME/office/catalog.local.json`，**不上报、平台不可见**。
 *
 * 形状：`{ schemaVersion: 1, entries: [...] }`，每条＝一条 `CatalogEntry`（`origin` 一律**强制为 `local`**，
 * 文件里写别的也忽略）。解析**宽松**——坏条目跳过并记 `problems`，一条坏不拖垮整份目录。
 *
 * 纯数据 + 纯函数（解析/校验/文件读写）；插件壳在 `index.ts`。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { CATALOG_KINDS, type CatalogEntry, type CatalogKind, type CatalogSource } from './catalog.ts'

/** 本地目录文件名（相对 `$DSH_HOME/office/`）。 */
export const LOCAL_CATALOG_FILE = 'catalog.local.json'

/** 本地目录文件 schema 版本。 */
export const LOCAL_CATALOG_SCHEMA = 1

/** 解析结果：合法条目 + 问题清单（坏条目被跳过）。 */
export interface LocalCatalogParseResult {
  readonly entries: CatalogEntry[]
  readonly problems: string[]
}

const SOURCE_KINDS: readonly CatalogSource['kind'][] = ['bundle', 'skill-provider', 'mcp', 'agent-preset']

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * 解析**单条**本地条目；返回 `CatalogEntry` 或一句问题（不抛）。
 * @param value - 原始 JSON 值。
 * @returns 条目或问题描述。
 */
function parseEntry(value: unknown): CatalogEntry | string {
  const r = asRecord(value)
  if (r === undefined) return '非对象'
  const id = str(r.id)
  const kind = str(r.kind)
  const name = str(r.name)
  if (id === undefined || id === '') return '缺 id'
  if (kind === undefined || !(CATALOG_KINDS as readonly string[]).includes(kind)) return `kind 非法：${String(r.kind)}`
  if (!id.startsWith(`${kind}:`)) return `id 前缀与 kind 不符：${id}`
  if (name === undefined || name === '') return '缺 name'
  const source = asRecord(r.source)
  const sourceKind = str(source?.kind)
  const tags = Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string') : []
  return {
    id,
    kind: kind as CatalogKind,
    name,
    description: str(r.description) ?? '',
    version: str(r.version) ?? '0.0.0',
    category: str(r.category) ?? '本地',
    origin: 'local',
    defaultEnabled: r.defaultEnabled === true,
    source: {
      kind: sourceKind !== undefined && (SOURCE_KINDS as readonly string[]).includes(sourceKind)
        ? (sourceKind as CatalogSource['kind']) : 'bundle',
      ref: str(source?.ref) ?? id,
    },
    tags,
  }
}

/**
 * 解析本地目录文件内容。
 * @param value - 已 JSON.parse 的值。
 * @returns 合法条目（`origin='local'`）+ 问题清单。
 */
export function parseLocalCatalog(value: unknown): LocalCatalogParseResult {
  const problems: string[] = []
  const entries: CatalogEntry[] = []
  const root = asRecord(value)
  if (root === undefined) return { entries, problems: ['本地目录不是对象'] }
  if (root.schemaVersion !== LOCAL_CATALOG_SCHEMA) problems.push(`本地目录 schemaVersion 非 ${LOCAL_CATALOG_SCHEMA}（忽略）`)
  const raw = root.entries
  if (!Array.isArray(raw)) return { entries, problems: [...problems, '本地目录 entries 非数组'] }
  for (const [index, item] of raw.entries()) {
    const parsed = parseEntry(item)
    if (typeof parsed === 'string') problems.push(`第 ${index} 条：${parsed}`)
    else entries.push(parsed)
  }
  return { entries, problems }
}

/**
 * 读本地目录文件（不存在/坏 JSON → 空数组，不抛）。
 * @param path - 文件路径。
 * @returns 本地条目。
 */
export function readLocalCatalog(path: string): CatalogEntry[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  try {
    return parseLocalCatalog(JSON.parse(text)).entries
  } catch {
    return []
  }
}

/**
 * 写本地目录文件（整份覆盖；供后续「新建本地条目」用）。
 * @param path - 文件路径。
 * @param entries - 本地条目（`origin` 一律落 `local`）。
 */
export function writeLocalCatalog(path: string, entries: readonly CatalogEntry[]): void {
  mkdirSync(dirname(path), { recursive: true })
  const body = entries.map((entry) => ({ ...entry, origin: 'local' }))
  writeFileSync(path, `${JSON.stringify({ schemaVersion: LOCAL_CATALOG_SCHEMA, entries: body }, undefined, 2)}\n`)
}
