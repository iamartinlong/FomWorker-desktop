/**
 * 「本地模式」标记的**宿主侧落点**。
 *
 * 为什么需要它：模式选择发生在浏览器（`localStorage['fomworker.mode']`），但**宿主插件
 * 看不见 localStorage**。而平台相关插件（`office-channel` 等）需要在启动时判断「用户明确
 * 选了不连平台」以避免每 5s 一次的无谓重试与日志噪音（2026-10-19 本地模式实测）。
 *
 * 通道：浏览器把选择经认证路由 `POST /api/office/login/mode` 写到这里，落一个标记文件
 * `$DSH_HOME/office/login-mode.json`（`{ mode: 'local' | 'signed' | 'gate' }`）。
 * 宿主插件读同一个文件即可，**不需要跨插件服务依赖**。
 *
 * 失败一律**保守**：读不到 / 解析不了 ⇒ 当作「非本地模式」（保持原来 `loginRetryMs` 快重试）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 三种模式（与浏览器侧 `mode.ts` 的 `AppMode` 一致）。 */
export type HostMode = 'gate' | 'local' | 'signed'

/** 标记文件名。 */
const FILE_NAME = 'login-mode.json'

/**
 * 标记文件路径（`$DSH_HOME/office/login-mode.json`）。
 * @returns 绝对路径
 */
export function modeFilePath(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'office', FILE_NAME)
}

/**
 * 写入模式标记（原子性不做额外处理：单行小文件，最坏是读到半行 ⇒ 按保守值处理）。
 * @param mode 模式
 * @param path 可注入路径（单测）
 */
export function writeHostMode(mode: HostMode, path = modeFilePath()): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ mode })}\n`, 'utf8')
}

/**
 * 读模式标记；读不到 / 坏文件 ⇒ `undefined`（调用方按「非本地模式」处理）。
 * @param path 可注入路径（单测）
 * @returns 模式，或 `undefined`
 */
export function readHostMode(path = modeFilePath()): HostMode | undefined {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as { mode?: unknown }
    return parsed.mode === 'local' || parsed.mode === 'signed' || parsed.mode === 'gate' ? parsed.mode : undefined
  } catch {
    return undefined
  }
}

/**
 * 用户是否**明确选了本地模式**（只有这个值为真才该降频）。
 * @param path 可注入路径
 * @returns 是否本地模式
 */
export function isLocalModeChosen(path = modeFilePath()): boolean {
  return readHostMode(path) === 'local'
}
