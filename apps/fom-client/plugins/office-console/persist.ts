/**
 * `office-console` 的**本地持久化**：把「能力启用态 / 审批」落 `$DSH_HOME/office/*.json`（跨重启）。
 *
 * 小状态、整份读写；「一 home 一活实例」下无并发写，故不加锁。写前建父目录，坏 JSON 读成 `undefined`
 * （调用方回落默认），不让一个坏文件挡住整个控制台。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 读 JSON 文件；不存在 / 坏 JSON → `undefined`（不抛）。 */
export function readJsonFile<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

/** 写 JSON 文件（整份覆盖，自动建父目录）。 */
export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`)
}

/** 解析 `$DSH_HOME`（与内核一致：环境变量优先，否则 `~/.dsh`）。 */
export function resolveDshHome(): string {
  const home = process.env.DSH_HOME
  return home !== undefined && home !== '' ? home : join(homedir(), '.dsh')
}

/** 控制台本地状态目录（`$DSH_HOME/office`）。 */
export function consoleStateDir(home: string = resolveDshHome()): string {
  return join(home, 'office')
}
