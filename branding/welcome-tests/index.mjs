import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 改写后的 welcome 测试与快照（官方授权页删除后，内核自带那组指向不存在的 UI）。
 *
 * 作为**产品仓资产**保存，由 `apply-welcome-entry.mjs` 覆盖进内核树——这样 CI 每次
 * clone 全新内核后重放补丁，也能得到同一组测试与快照。
 */
const FILES = ['welcome-host.spec.ts', 'welcome-renderer.client.spec.tsx', 'welcome-startup.spec.ts', 'welcome-window.spec.ts']

/** 品牌页只剩两页，这两份对应的命名快照仍在。 */
const SNAPSHOTS = ['zh-CN.expected.txt', 'en.expected.txt']

/** 官方授权页（API Key / 超时 / 等待 / 退出）删除后不再被任何测试引用。 */
const STALE_SNAPSHOTS = [
  'en-api-key.expected.txt', 'en-expired.expected.txt', 'en-timeout.expected.txt', 'en-waiting.expected.txt',
  'zh-CN-api-key.expected.txt', 'zh-CN-expired.expected.txt', 'zh-CN-timeout.expected.txt', 'zh-CN-waiting.expected.txt',
]

const here = dirname(fileURLToPath(import.meta.url))

/** 已一致则不写；返回实际写入/删除的数量。 */
function sync(source, destination) {
  const content = readFileSync(source, 'utf8')
  let current
  try {
    current = readFileSync(destination, 'utf8')
  } catch {
    current = undefined
  }
  if (current === content) return 0
  writeFileSync(destination, content)
  return 1
}

/**
 * 覆盖内核里改写过的那组 welcome 测试与快照。
 * @param desktopRoot - 内核 `apps/desktop` 绝对路径。
 * @returns 实际写入/删除的数量（已一致的不计）。
 */
export function writeWelcomeTests(desktopRoot) {
  let written = 0
  for (const name of FILES) {
    written += sync(join(here, name), join(desktopRoot, 'tests', name))
  }
  for (const name of SNAPSHOTS) {
    written += sync(join(here, 'expected', 'welcome', name), join(desktopRoot, 'tests', 'expected', 'welcome', name))
  }
  for (const stale of STALE_SNAPSHOTS) {
    const target = join(desktopRoot, 'tests', 'expected', 'welcome', stale)
    if (!existsSync(target)) continue
    rmSync(target)
    written += 1
  }
  return written
}
