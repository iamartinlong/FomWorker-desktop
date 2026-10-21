/**
 * 桌面仓导出清单的一致性校验（零依赖）。
 *
 * ## 为什么需要它（2026-10-21 `pkg-15` 实测）
 *
 * `scripts/sync-desktop-repo.ps1` 用一个**手工白名单**决定哪些文件进桌面仓（GitHub Actions 只
 * 拿得到那批文件）。白名单漏一个文件，CI 就在运行到那一步时才 `MODULE_NOT_FOUND`——而且是在
 * 30 秒内挂掉，看不出「文件没同步」还是「脚本自己坏了」。
 *
 * `pkg-15` 就是这样：新增 `scripts/check-kernel-host.mjs` 并接进 workflow，但没加进白名单 ⇒
 * `Cannot find module '...\scripts\check-kernel-host.mjs'`。
 *
 * ## 判据
 *
 * 1. `.github/workflows/package.yml` 里 `run:` 调用到的**每个仓库内脚本**都必须在白名单里；
 * 2. 白名单里的每一项在仓库里必须真实存在（防拼写错误 / 防删了文件忘了删条目）。
 *
 * 用法（产品仓根）：node scripts/check-sync-list.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failed = false
const fail = (message) => {
  console.error('✗ ' + message)
  failed = true
}

const workflowPath = '.github/workflows/package.yml'
const syncPath = 'scripts/sync-desktop-repo.ps1'

// 1) 白名单
let allowed = []
try {
  const source = readFileSync(join(root, syncPath), 'utf8')
  // 只取 `$paths = @(` 到 `)` 之间的单引号条目，避开脚本注释里的示例路径。
  const block = /\$paths\s*=\s*@\(([\s\S]*?)\r?\n\)/u.exec(source)
  if (block === null) throw new Error('没解析出 $paths 数组（正则可能已与源码脱节）')
  allowed = [...block[1].matchAll(/'([^']+)'/gu)].map(([, entry]) => entry)
  if (allowed.length === 0) throw new Error('$paths 里没解析出任何条目')
} catch (error) {
  fail(`${syncPath}: 读取失败：${error.message}`)
}

// 2) workflow 里调用到的仓库内脚本
let invoked = []
try {
  const source = readFileSync(join(root, workflowPath), 'utf8')
  // `node <path>` 形式的调用；忽略 `node -e` 与绝对/带变量的路径。
  invoked = [...source.matchAll(/\bnode\s+([A-Za-z0-9_.\/-]+\.(?:mjs|cjs|js))/gu)]
    .map(([, file]) => file)
    .filter(file => !file.startsWith('$'))
} catch (error) {
  fail(`${workflowPath}: 读取失败：${error.message}`)
}

/** 白名单条目是否覆盖某个被调用的文件（目录条目按前缀算）。 */
const covered = (file) => allowed.some((entry) => entry === file || file.startsWith(entry.replace(/\/$/u, '') + '/'))

for (const file of [...new Set(invoked)]) {
  if (!covered(file)) {
    fail(`${file} 被 ${workflowPath} 调用，但不在 ${syncPath} 的 $paths 白名单里`
      + ` ⇒ 桌面仓里没有这个文件 ⇒ CI 会在那一步 MODULE_NOT_FOUND`)
  }
}

// 3) 反向：白名单里的每一项都必须真实存在
for (const entry of allowed) {
  if (!existsSync(join(root, entry))) fail(`${syncPath}: 白名单里的 ${entry} 在仓库里不存在`)
}

if (failed) {
  console.error('桌面仓导出清单校验失败')
  process.exit(1)
}
console.log(`✓ 桌面仓导出清单一致（workflow 调用的 ${String(new Set(invoked).size)} 个脚本都被白名单覆盖，白名单 ${String(allowed.length)} 项全部存在）`)
