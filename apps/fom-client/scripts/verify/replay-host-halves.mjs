/**
 * 重放 host 半构建并与 **committed 产物**做字节比对——「改了源码忘了重建 lib」的探测器。
 *
 * 为什么需要（踩坑 §2.29 / §2.30）：
 *   - CI 的 `package.yml` **不跑任何构建步骤**，`apply-packaging-overlay.mjs` 用 `cpSync`
 *     整目录拷贝（含 `lib/`）⇒ **打进安装器的就是 committed 的 `lib/index.js`**；
 *   - 护栏 `scripts/check-packaging.mjs` 只 `existsSync` 查「在不在」、**不查新鲜度**；
 *   - ⇒ 只改 `index.ts` 不重建，CI 打出来的安装器仍是旧代码，而且没有任何一道红。
 *
 * 本脚本按 `build-host-halves.mjs` **同一套选项**重放，逐个与 committed 产物逐字节比。
 * **多数一致 + 一个不一致**才能同时证明两件事：重放环境忠实、那个不一致的真是手改件。
 * （只比一个无法区分「我的环境错了」与「那份产物是假的」。）
 *
 * 用法：
 *   node scripts/verify/replay-host-halves.mjs            # 只比对，不改仓库
 *   node scripts/verify/replay-host-halves.mjs --write     # 不一致的直接用重放产物覆盖
 *   node scripts/verify/replay-host-halves.mjs office-skills   # 只查指定插件
 *
 * 前置：esbuild 原生二进制。仓库里只有 JS 主包，缺平台包时先临时装一个（**不入库**）：
 *   mkdir -p /tmp/fom-esbuild && cd /tmp/fom-esbuild
 *   npm pack @esbuild/win32-x64@<版本>      # 版本见 apps/fom-client/node_modules/esbuild/package.json
 *   tar -xzf esbuild-*.tgz
 *   export ESBUILD_BINARY_PATH=/tmp/fom-esbuild/package/esbuild.exe      # Windows 用 $env:
 * 之后本脚本与 `build-host-halves.mjs` 都能跑了。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOST_ONLY } from '../host-only-plugins.mjs'

// esbuild 用**裸导入**（与 build-host-halves.mjs 一致）：本机从 apps/fom-client/node_modules 解析，
// CI 里 workflow 会在桌面仓根装一份、同样落在这条查找链上。
// ⚠️ 版本必须与产出 committed 产物那次一致，否则字节对不上会**假红**——版本钉在
// `apps/fom-client/scripts/esbuild-version.json`，换版本要有意识地改那里。
let build
try {
  ({ build } = await import('esbuild'))
} catch {
  console.error('✗ 找不到 esbuild 模块。')
  console.error('  本机：按 README 临时装同版本 @esbuild/win32-x64 + 设 ESBUILD_BINARY_PATH')
  console.error('  CI  ：由 package.yml 按 esbuild-version.json 安装')
  process.exit(2)
}

const here = dirname(fileURLToPath(import.meta.url))
// 本脚本在 apps/fom-client/scripts/verify/ ⇒ 上四级才是仓库根
// （build-host-halves.mjs 在 scripts/ 只上三级，别照抄它的层级）
const repoRoot = join(here, '..', '..', '..', '..')
const pluginsDir = join(repoRoot, 'apps', 'fom-client', 'plugins')

const argv = process.argv.slice(2)
const write = argv.includes('--write')
const only = argv.filter((a) => !a.startsWith('--'))
const names = only.length === 0 ? HOST_ONLY : only

const unknown = names.filter((n) => !HOST_ONLY.includes(n))
if (unknown.length > 0) {
  console.error(`✗ 不在 HOST_ONLY 清单里：${unknown.join(', ')}`)
  console.error(`  清单：${HOST_ONLY.join(', ')}`)
  process.exit(2)
}

const out = mkdtempSync(join(tmpdir(), 'fom-replay-'))
let failed = 0
let stale = []

try {
  for (const name of names) {
    const entry = join(pluginsDir, name, 'index.ts')
    const committedPath = join(pluginsDir, name, 'lib', 'index.js')
    if (!existsSync(entry)) { console.log(`- ${name}：没有 index.ts，跳过`); continue }
    if (!existsSync(committedPath)) {
      console.log(`✗ ${name}：committed lib/index.js 不在（CI 会打出缺入口产物的包）`)
      failed += 1
      continue
    }
    const replayPath = join(out, `${name}.js`)
    await build({
      entryPoints: [entry],
      outfile: replayPath,
      absWorkingDir: repoRoot,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'es2024',
      packages: 'external',
      sourcemap: false,
      logLevel: 'warning',
    })
    const a = readFileSync(replayPath)
    const b = readFileSync(committedPath)
    // ⚠️ **必须先按 LF 归一化再判**（2026-11-05 pkg-34 首跑 12/12 全红才发现的）：
    // CI 的 `actions/checkout` 在 Windows 上按 Git for Windows 默认 `core.autocrlf=true`
    // 把仓库里 LF 的文件落成 CRLF ⇒ committed 产物在 CI 工作树里比本地大「每行一个 CR」。
    // 本地仓库是 LF（CR=0），所以本地全绿、CI 全红——差值精确等于行数（实测 12/12 吻合）。
    // 这与装机版验收那条同源（实践篇 §2.5-#8 / §3.1）：**看字节数差先数 CR/LF**。
    const crOf = (buf) => buf.reduce((n, byte) => (byte === 13 ? n + 1 : n), 0)
    const lfOf = (buf) => buf.reduce((n, byte) => (byte === 10 ? n + 1 : n), 0)
    const stripCr = (buf) => Buffer.from(buf.filter((byte) => byte !== 13))
    const rawSame = a.length === b.length && a.equals(b)
    const normSame = (() => {
      const na = stripCr(a); const nb = stripCr(b)
      return na.length === nb.length && na.equals(nb)
    })()
    if (rawSame) {
      console.log(`✓ ${name}：与 committed 产物逐字节一致（${a.length} B）`)
    } else if (normSame) {
      // 内容一致、只是行尾——**不算过期**，但要把话说清楚，别让人以为蒙混过去
      console.log(`✓ ${name}：内容一致（仅行尾不同：committed 有 ${crOf(b)} 个 CR、LF ${lfOf(b)} 行；`
        + `重放 ${a.length} B vs committed ${b.length} B）——CI checkout 的 CRLF 转换，非产物过期`)
    } else {
      console.log(`✗ ${name}：不一致——重放 ${a.length} B vs committed ${b.length} B`
        + `（原样差 ${b.length - a.length >= 0 ? '+' : ''}${b.length - a.length} B，LF 归一化后仍不一致）`)
      stale.push(name)
      failed += 1
      if (write) {
        mkdirSync(dirname(committedPath), { recursive: true })
        rmSync(committedPath)
        // 逐字节拷贝（不用文本读写，避免行尾/编码被改）
        const { copyFileSync } = await import('node:fs')
        copyFileSync(replayPath, committedPath)
        console.log(`  → 已用重放产物覆盖 committed lib/index.js`)
      }
    }
  }
} finally {
  rmSync(out, { recursive: true, force: true })
}

if (stale.length > 0 && !write) {
  console.log(`\n${stale.length} 个插件的 committed 产物与真实构建不一致：${stale.join(', ')}`)
  console.log('先确认是不是有人手改过产物（踩坑 §2.30：手写注释 / import 被拆 / 缺 /* @__PURE__ */），')
  console.log('确认该更新就加 --write；否则把源码改回去。')
}
console.log(failed === 0 ? '\n✓ 全部一致（含仅行尾不同的）' : `\n✗ ${failed} 个不一致`)
process.exit(failed === 0 ? 0 : 1)
