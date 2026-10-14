/**
 * 运维辅助（M2/B · O-P0 的备份核心）：把「`$DSH_HOME` 该备什么」从设计稿落成可执行、可测的纯逻辑。
 *
 * 依据：`docs/02-设计/部署与运维形态设计v0.1.md` §O4 的备份清单。
 * **必须备**：`sessions/`、`storages/`、`attachments/`、`.credentials.yaml`、`.env`、`.anonymous-user-id`、
 * `cordis.patch.yml`、`profiles/`。**可丢**：`cache/`、`logs/`、`node_modules`。
 *
 * 冷备：调用方须**先停写**（一 home 一活实例，O6）再调 `backupHome`。
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** `$DSH_HOME` 下**必须备份**的顶层条目（相对路径）。 */
export const BACKUP_ENTRIES: readonly string[] = Object.freeze([
  'sessions',
  'storages',
  'attachments',
  '.credentials.yaml',
  '.env',
  '.anonymous-user-id',
  'cordis.patch.yml',
  'profiles',
])

/** 明确**不需备份**的顶层条目（派生态/可再生）。 */
export const DISPOSABLE_ENTRIES: readonly string[] = Object.freeze([
  'cache',
  'logs',
])

/**
 * 列出某 home 下**实际存在**的必备份条目。
 * @param homeDir - `$DSH_HOME` 目录。
 * @returns 存在的顶层条目名（顺序同 `BACKUP_ENTRIES`）。
 */
export function existingBackupEntries(homeDir: string): string[] {
  return BACKUP_ENTRIES.filter((entry) => existsSync(join(homeDir, entry)))
}

/**
 * 冷备一个 home 的必备份条目到目标目录（递归复制）。
 * @param homeDir - 源 `$DSH_HOME`。
 * @param destDir - 目标目录（不存在则建）。
 * @returns 实际复制的条目名。
 */
export function backupHome(homeDir: string, destDir: string): string[] {
  const copied = existingBackupEntries(homeDir)
  mkdirSync(destDir, { recursive: true })
  for (const entry of copied) {
    cpSync(join(homeDir, entry), join(destDir, entry), { recursive: true })
  }
  return copied
}
