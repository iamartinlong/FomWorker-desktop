/**
 * **client 半产物的新鲜度门禁**（轻量版）——`replay-host-halves.mjs` 的姊妹脚本，
 * 补上它漏掉的那一半（2026-11-06 `pkg-36` 事故的直接产物：七批新代码只重放了 host 半，
 * `office-console` 的 client 半从没重建过 ⇒ 装机版 host 是新的、界面是旧的）。
 *
 * **为什么从「字节重放」降为「源码比产物新」**：
 * 试过 6 种字节重放方案，全部差一口气，根子是**开发机与 CI 的模块解析形状不同**——
 * 开发机上 `@fominfo/dsh-ui` 是 junction，Node/rolldown 会**还原成真实路径**
 * （`apps/fom-client/ui/src/Card.tsx`）；CI 里无论 symlink 还是 junction 都还原不了
 * （`node_modules/@fominfo/dsh-ui/src/Card.tsx`）⇒ 产物里的模块注释必然不同。
 * 这不是 bug，是两种环境的固有差异；硬凑字节一致是在和自己的工具链打仗。
 *
 * 而降级**不损失这道门禁的目的**：它要防的是「改了 src/ 忘了重建 lib/」——
 * 用**源码 mtime vs 产物 mtime** 就能抓住，且零环境依赖、零安装、秒级跑完。
 * （git checkout 会重置 mtime，故 CI 上判据改为「产物是否存在于 git 中且 src 无更新」——
 * 见下 `gitHasLatestCommit`。）
 *
 * 用法：
 *   node apps/fom-client/scripts/verify/check-client-halves.mjs
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 双半插件（有 `dsh.client` 的）——与 `build-bundles.ps1` 的清单保持一致。 */
const CLIENT_PLUGINS = ['office-console', 'office-login', 'office-assistant', 'ui-brand-fomworker']

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..', '..')
const pluginsDir = join(repoRoot, 'apps', 'fom-client', 'plugins')

/** 某插件 src/ 下最新的 mtime（递归）。 */
function newestMtime(dir) {
  let newest = 0
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else {
        const m = statSync(p).mtimeMs
        if (m > newest) newest = m
      }
    }
  }
  walk(dir)
  return newest
}

/**
 * 某路径最后一次被改动的提交**时间戳**（git 判据用；CI 上 mtime 不可信）。
 *
 * ⚠️ 不能用 SHA 比大小：SHA 是哈希，**字典序与时间序无关**
 * （实测：`2e5bba6` 晚于 `41917e1` 发生，但字典序更小）⇒ 必须取提交时间。
 * @param {string} p - 仓库内路径。
 * @returns {number | undefined} Unix 时间戳（秒）；取不到 ⇒ `undefined`。
 */
function lastCommitTime(p) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%ct', '--', p], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
    const n = Number(out.trim())
    return Number.isFinite(n) && n > 0 ? n : undefined
  } catch {
    return undefined
  }
}

let failed = 0
for (const name of CLIENT_PLUGINS) {
  const dir = join(pluginsDir, name)
  const committed = join(dir, 'lib', 'client.js')
  const src = join(dir, 'src')
  if (!existsSync(committed)) {
    console.log(`✗ ${name}：committed lib/client.js 不在（双半插件缺客户端产物 ⇒ 界面缺这块）`)
    failed += 1
    continue
  }
  if (!existsSync(src)) {
    console.log(`- ${name}：没有 src/（跳过）`)
    continue
  }
  const srcNewest = newestMtime(src)
  const libMtime = statSync(committed).mtimeMs
  if (srcNewest > libMtime + 1000) {
    console.log(`✗ ${name}：src/ 有比 lib/client.js 新的文件 ⇒ 客户端产物过期，跑 build-bundles.ps1`)
    failed += 1
    continue
  }
  // CI 上 git checkout 会重置 mtime ⇒ 本地判据失效。补一个 git 判据：
  // **改动 src/ 的最后提交，不该晚于改动 lib/ 的最后提交**（否则就是忘了重建）。
  const srcTime = lastCommitTime(src)
  const libTime = lastCommitTime(dirname(committed))
  if (srcTime !== undefined && libTime !== undefined && srcTime > libTime) {
    console.log(`✗ ${name}：src/ 的最后改动晚于 lib/client.js ⇒ 忘了重建，跑 build-bundles.ps1`)
    failed += 1
    continue
  }
  console.log(`✓ ${name}：lib/client.js 不旧于 src/（${statSync(committed).size} B）`)
}

// ─────────────────────────────────────────────────────────────────────────────
// 第二道：externals drift（2026-11-06 `pkg-39` 装机即崩的直接产物）
//
// 上面那道新鲜度门禁**防得住「忘了重建」，防不住「重建了却重建错了」**：
// `office-console` 的 `ConnectorConfigDialog.tsx` 把包名写错一个字母
// （`@fominio/dsh-ui`，真名 `@fominio/dsh-ui`）——开发机上解析失败时 rolldown **不报错**，
// 只是把它留成外部 `require("@fominio/dsh-ui")`；mtime 判据看到「lib 比 src 新」照样放行。
// 装机后运行时模块表里没有这一项 ⇒ `require` 抛错 ⇒ client 入口激活失败 ⇒ web boot 挂。
//
// 判据因此是**硬的、可枚举的**：允许留在产物里的 require ＝
//   ① 平台的 `PLATFORM_MODULES`（壳预置进冻结模块表的种子词，见内核
//      `packages/client/web/src/platform.ts`；React/Cordis/ui-primitives 等都在里面）
// ∪ ② 本插件 `tsdown.config.ts` 的 `external` 白名单。
// 除此之外任何一个 `require("...")` 都是 build-time externals drift。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 平台种子词。**优先读内核源码**（唯一真相源），内核没检出时用内置兜底，
 * 并把来源打在输出里——兜底与内核不一致时这道门禁会给错结论，必须看得见。
 * @returns {{ list: string[], source: string }}
 */
function readPlatformModules() {
  const kernelFile = join(repoRoot, 'deepseek-harness', 'packages', 'client', 'web', 'src', 'platform.ts')
  if (existsSync(kernelFile)) {
    const text = readFileSync(kernelFile, 'utf8')
    const m = /PLATFORM_MODULES\s*=\s*\[([^\]]*)\]/su.exec(text)
    if (m !== null) {
      const list = [...m[1].matchAll(/'([^']+)'/gu)].map((x) => x[1])
      if (list.length > 0) return { list, source: '内核 packages/client/web/src/platform.ts' }
    }
  }
  return { list: [...BUILTIN_PLATFORM_MODULES], source: '内置兜底（内核未检出，值需与内核保持一致）' }
}

/** 内置兜底（2026-11-06 照内核抄的）；内核检出时不用它。 */
const BUILTIN_PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/**
 * 从插件的 `tsdown.config.ts` 里取出 `external: [...]` 的条目，转成判据。
 * 只认两种字面形式（本仓四个 client 半插件全是这两种）：字符串、正则字面量。
 * @param {string} configPath - tsdown.config.ts 路径。
 * @returns {{ literals: string[], patterns: RegExp[] }}
 */
function readExternals(configPath) {
  const literals = []
  const patterns = []
  if (!existsSync(configPath)) return { literals, patterns }
  const text = readFileSync(configPath, 'utf8')
  const m = /external\s*:\s*\[([^\]]*)\]/u.exec(text)
  if (m === null) return { literals, patterns }
  // 条目之间按顶层逗号切（本仓的 external 数组里没有嵌套逗号，按这个简单形状处理）
  for (const raw of m[1].split(',')) {
    const item = raw.trim()
    if (item === '') continue
    const str = /^['"]([^'"]+)['"]$/u.exec(item)
    if (str !== null) {
      literals.push(str[1])
      continue
    }
    const re = /^\/(.+)\/([a-z]*)$/u.exec(item)
    if (re !== null) {
      try {
        patterns.push(new RegExp(re[1], re[2]))
      } catch {
        /* 正则本身不合法时忽略，交给下面的漂移检查报出来 */
      }
    }
  }
  return { literals, patterns }
}

const platform = readPlatformModules()
console.log(`平台种子词来源：${platform.source}（${String(platform.list.length)} 项）`)

for (const name of CLIENT_PLUGINS) {
  const dir = join(pluginsDir, name)
  const committed = join(dir, 'lib', 'client.js')
  const configPath = join(dir, 'tsdown.config.ts')
  if (!existsSync(committed)) continue // 上面已经报过

  const { literals, patterns } = readExternals(configPath)
  if (literals.length === 0 && patterns.length === 0) {
    console.log(`✗ ${name}：读不到 tsdown.config.ts 的 external 白名单 ⇒ 无法判 drift，请手动核对该文件`)
    failed += 1
    continue
  }

  const allowed = (spec) =>
    platform.list.includes(spec) ||
    literals.includes(spec) ||
    patterns.some((p) => p.test(spec))

  const text = readFileSync(committed, 'utf8')
  const seen = new Set()
  const re = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/gu
  let drift = []
  for (const m of text.matchAll(re)) {
    const spec = m[1]
    if (seen.has(spec)) continue
    seen.add(spec)
    if (!allowed(spec)) drift.push(spec)
  }

  if (drift.length > 0) {
    console.log(`✗ ${name}：产物里有 ${drift.length} 个未声明 external 的 require ⇒ build-time drift`)
    for (const spec of drift) console.log(`      require(${JSON.stringify(spec)})  —— 拼错了？还是忘了加进 external？`)
    console.log(`      装机后它会在模块表里找不到 ⇒ require 抛错 ⇒ client 入口激活失败 ⇒ web boot 挂`)
    failed += 1
    continue
  }
  console.log(`✓ ${name}：产物里的 require 全部在白名单内（${String(seen.size)} 个）`)
}

console.log(failed === 0 ? '\n✓ client 半产物都在' : `\n✗ ${failed} 个插件的 client 半过期`)
process.exit(failed === 0 ? 0 : 1)
