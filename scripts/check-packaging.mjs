// 打包输入一致性校验（零依赖）：**bundle patch 注册的插件必须都在打包 overlay 的 STAGE 里**，
// 且每个包的入口产物（`main` / `exports["."]`，以及双半插件的客户端半）必须已入库。
//
// 为什么需要它：`branding/apply-packaging-overlay.mjs` 的 `STAGE` 是**手工清单**，与
// `apps/fom-client/bundle/cordis.patch.yml` 注册的插件**两处独立维护**。2026-10-19 就漏了
// `@office/{delegate,tasks,assistant}` 三包 —— CI 照常绿、安装器照常出，**只有装完才会发现界面缺块**。
// 判据：bundle patch 的 `name:` 集合 ⊆ overlay `STAGE`，且入口产物在场。
//
// 用法：node scripts/check-packaging.mjs
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failed = false
const fail = (message) => {
  console.error('✗ ' + message)
  failed = true
}

const overlayPath = 'branding/apply-packaging-overlay.mjs'
const patchPath = 'apps/fom-client/bundle/cordis.patch.yml'

// 1) overlay STAGE：只认「包名 + apps/ 开头的相对目录」对（避开脚本里 scopes 那类常量）
let stage = []
try {
  const source = readFileSync(join(root, overlayPath), 'utf8')
  stage = [...source.matchAll(/\['(@[^']+)',\s*'(apps\/[^']+)'\]/gu)].map(([, pkg, rel]) => ({ pkg, rel }))
  if (stage.length === 0) fail(`${overlayPath}: 没解析出 STAGE 条目（正则可能已与源码脱节）`)
} catch (error) {
  fail(`${overlayPath}: 读取失败：${error.message}`)
}

// 2) bundle patch 里注册的插件包名
let declared = []
try {
  const source = readFileSync(join(root, patchPath), 'utf8')
  declared = [...source.matchAll(/^\s+name:\s*'(@[^']+)'/gmu)].map(([, name]) => name)
  if (declared.length === 0) fail(`${patchPath}: 没解析出任何 name:`)
} catch (error) {
  fail(`${patchPath}: 读取失败：${error.message}`)
}

// 3) 覆盖：bundle patch ⊆ overlay STAGE
const staged = new Set(stage.map((row) => row.pkg))
for (const name of declared) {
  if (!staged.has(name)) {
    fail(`${name} 在 bundle patch 里注册了，但 overlay STAGE 没有它 ⇒ 安装后这个插件不在运行时里`)
  }
}

// 4) 入口产物：声明了入口的包，产物必须已入库（否则打进安装器的包加载不了）
for (const { pkg, rel } of stage) {
  const dir = join(root, rel)
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    fail(`${pkg}: 缺 ${rel}/package.json`)
    continue
  }

  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    fail(`${pkg}: package.json 解析失败：${error.message}`)
    continue
  }

  const entry = manifest.main ?? manifest.exports?.['.']
  if (entry === undefined) continue // bundle 补丁包无入口，跳过
  if (typeof entry !== 'string' || !existsSync(join(dir, entry))) {
    fail(`${pkg}: 入口产物缺失（${String(entry)}）——先跑 build-bundles.ps1 / tsdown`)
    continue
  }

  // 双半插件：客户端半也必须入库（否则界面上没有这一块）
  if (manifest.dsh?.client !== undefined && !existsSync(join(dir, 'lib/client.js'))) {
    fail(`${pkg}: 声明了 dsh.client（双半插件），但 lib/client.js 不在`)
  }
}

if (failed) {
  console.error('打包输入一致性校验失败')
  process.exit(1)
}
console.log(`✓ 打包输入一致（bundle patch ${String(declared.length)} 包 ⊆ overlay STAGE ${String(stage.length)} 包，入口产物全在场）`)
