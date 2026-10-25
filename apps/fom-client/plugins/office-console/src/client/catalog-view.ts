/**
 * office-console 的**视图逻辑**（纯函数，无 React）——从面板组件抽出来以便单测。
 */

/** 目录条目（来自 `/office/catalog`）。 */
export interface CatalogEntry {
  id: string
  kind: string
  name: string
  description?: string
  version?: string
  category?: string
  icon?: string
  /** 来源：`platform`（平台内置/下发）或 `local`（本地自建）。 */
  origin?: string
  source?: { kind?: string; ref?: string }
}

/** 市场 / 已安装 双态。 */
export type ConsoleView = 'market' | 'installed'

/** 按 `kind` 分组（保序）。 */
export function groupByKind(entries: readonly CatalogEntry[]): Record<string, CatalogEntry[]> {
  const out: Record<string, CatalogEntry[]> = {}
  for (const entry of entries) (out[entry.kind] ??= []).push(entry)
  return out
}

/** 分类去重（保序，剔空）。 */
export function categoriesOf(entries: readonly CatalogEntry[]): string[] {
  return [...new Set(entries.map((e) => e.category).filter((c): c is string => c !== undefined && c !== ''))]
}

/** 视图过滤：市场/已安装 + 分类。 */
export function filterEntries(
  entries: readonly CatalogEntry[],
  view: ConsoleView,
  category: string | null,
  enabled: Record<string, boolean>,
): CatalogEntry[] {
  let list = [...entries]
  if (view === 'installed') list = list.filter((e) => enabled[e.id] === true)
  if (category !== null) list = list.filter((e) => e.category === category)
  return list
}
