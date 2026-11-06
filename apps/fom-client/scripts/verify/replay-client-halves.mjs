/**
 * **client 半（`lib/client.js`）的新鲜度门禁**——`replay-host-halves.mjs` 的姊妹脚本，
 * 补上它漏掉的那一半（2026-11-06 `pkg-36` 事故的直接产物：七批新代码只重放了 host 半，
 * `office-console` 的 client 半从没重建过 ⇒ 装机版 host 是新的、界面是旧的）。
 *
 * **为什么必须单独一个脚本**：client 半走 **tsdown**（不是 esbuild），且**不在**
 * `build-host-halves.mjs` 的 `HOST_ONLY` 列表里（那个清单的语义就是「browser-only 的另有 tsdown 链」）。
 * 两个构建链、两份产物、两把门禁——这就是踩坑 §2.6/§2.29 反复出现的位置。
 *
 * 判据与 host 半相同：**按 tsdown 同一套配置重放到临时目录，与 committed 产物逐字节比**；
 * 多数一致才能证明重放环境忠实（5 个双半插件里改了几个，就应该有几个不一致）。
 * 行尾同样先按 LF 归一化再比（CI checkout 的 CRLF，详案 §2.5-#10）。
 *
 * 用法：
 *   node apps/fom-client/scripts/verify/replay-client-halves.mjs            # 只比对
 *   node apps/fom-client/scripts/verify/replay-client-halves.mjs --write    # 不一致就覆盖
 *   node apps/fom-client/scripts/verify/replay-client-halves.mjs office-console  # 只查一个
 *
 * 前置：各插件目录自带 `node_modules/.bin/tsdown.CMD`（`build-bundles.ps1` 同款检查）。
 * 与 host 半那把一样：**没有就明说缺哪个**，不静默跳过。
 *
 * ⚠️ **tsdown 小版本会改输出格式**：0.22.2 不给模块加 `//#region` 注释、0.22.14 加，
 * 两者字节对不上（2026-11-06 实测）。版本钉在 `../tsdown-version.json`——
 * CI 里按它装，本地换版本要有意识地改那个文件并重建全部四个。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 双半插件（有 `dsh.client` 的）——与 `build-bundles.ps1` 的清单保持一致。 */
const CLIENT_PLUGINS = ['office-console', 'office-login', 'office-assistant', 'ui-brand-fomworker']

const here = dirname(fileURLToPath(import.meta.url))
// 本脚本在 apps/fom-client/scripts/verify/ ⇒ 上四级才是仓库根
// （与 replay-host-halves.mjs 同层级；build-host-halves.mjs 在 scripts/ 只上三级，别照抄）
const repoRoot = join(here, '..', '..', '..', '..')
const pluginsDir = join(repoRoot, 'apps', 'fom-client', 'plugins')

const argv = process.argv.slice(2)
const write = argv.includes('--write')
const only = argv.filter((a) => !a.startsWith('--'))
const names = only.length === 0 ? CLIENT_PLUGINS : only

const unknown = names.filter((n) => !CLIENT_PLUGINS.includes(n))
if (unknown.length > 0) {
  console.error(`✗ 不在双半插件清单里：${unknown.join(', ')}`)
  console.error(`  清单：${CLIENT_PLUGINS.join(', ')}`)
  process.exit(2)
}

/** 该插件目录下的 tsdown 可执行（没有就返回 undefined，由调用方明说）。 */
function tsdownBin(name) {
  const cmd = join(pluginsDir, name, 'node_modules', '.bin', 'tsdown.CMD')
  return existsSync(cmd) ? cmd : undefined
}

const out = mkdtempSync(join(tmpdir(), 'fom-replay-client-'))
let failed = 0
let stale = []

try {
  for (const name of names) {
    const dir = join(pluginsDir, name)
    const committedPath = join(dir, 'lib', 'client.js')
    const bin = tsdownBin(name)
    if (bin === undefined) {
      console.log(`✗ ${name}：没有本地 tsdown（先在该插件目录 pnpm install）——无法比对，按失败算`)
      failed += 1
      continue
    }
    if (!existsSync(committedPath)) {
      console.log(`✗ ${name}：committed lib/client.js 不在（双半插件缺客户端产物 ⇒ 界面缺这块）`)
      failed += 1
      continue
    }
    // 重放到临时目录：tsdown 的 outDir 由配置里的 'lib' 决定 ⇒ 用 --out-dir 改到临时处
    // ⚠️ Windows 上 `.CMD` 不能直接被 execFileSync spawn（EINVAL）；而经 cmd /c 又会因
    // 仓库路径含空格被切断 ⇒ 用 shell:true（Node 自己按平台规则拼命令行并加引号）
    const replayDir = join(out, name)
    mkdirSync(replayDir, { recursive: true })
    try {
      execFileSync(`"${bin}" --out-dir "${replayDir}"`, { cwd: dir, stdio: 'pipe', shell: true })
    } catch (error) {
      console.log(`✗ ${name}：tsdown 重放失败：${String(error?.message ?? error)}`)
      failed += 1
      continue
    }
    const replayPath = join(replayDir, 'client.js')
    if (!existsSync(replayPath)) {
      console.log(`✗ ${name}：重放没产出 client.js（配置的 entry/outDir 变了？）`)
      failed += 1
      continue
    }
    const a = readFileSync(replayPath)
    const b = readFileSync(committedPath)
    const rawSame = a.length === b.length && a.equals(b)
    const stripCr = (buf) => Buffer.from(buf.filter((byte) => byte !== 13))
    const na = stripCr(a)
    const nb = stripCr(b)
    const normSame = na.length === nb.length && na.equals(nb)
    if (rawSame) {
      console.log(`✓ ${name}：client 半与 committed 产物逐字节一致（${a.length} B）`)
    } else if (normSame) {
      const cr = b.reduce((n, byte) => (byte === 13 ? n + 1 : n), 0)
      console.log(`✓ ${name}：内容一致（仅行尾不同：committed 有 ${cr} 个 CR）——CI checkout 的 CRLF 转换，非产物过期`)
    } else {
      console.log(`✗ ${name}：client 半不一致——重放 ${a.length} B vs committed ${b.length} B`
        + `（原样差 ${b.length - a.length >= 0 ? '+' : ''}${b.length - a.length} B，LF 归一化后仍不一致）`)
      stale.push(name)
      failed += 1
      if (write) {
        rmSync(committedPath)
        const { copyFileSync } = await import('node:fs')
        copyFileSync(replayPath, committedPath)
        console.log(`  → 已用重放产物覆盖 committed lib/client.js`)
      }
    }
  }
} finally {
  rmSync(out, { recursive: true, force: true })
}

if (stale.length > 0 && !write) {
  console.log(`\n${stale.length} 个插件的 client 半与真实构建不一致：${stale.join(', ')}`)
  console.log('确认该更新就加 --write；否则把源码改回去。')
  console.log('（这正是 2026-11-06 pkg-36 漏掉的那一步：只重放了 host 半。）')
}
console.log(failed === 0 ? '\n✓ 全部一致' : `\n✗ ${failed} 个不一致`)
process.exit(failed === 0 ? 0 : 1)
