/**
 * **client 半产物的新鲜度门禁**（轻量版）——`replay-host-halves.mjs` 的姊妹脚本，
 * 补上它漏掉的那一半（2026-11-06 `pkg-36` 事故的直接产物：七批新代码只重放了 host 半，
 * `office-console` 的 client 半从没重建过 ⇒ 装机版 host 是新的、界面是旧的）。
 *
 * **为什么从「字节重放」降为「源码比产物新」**：
 * 试过 6 种字节重放方案，全部差一口气，根子是**开发机与 CI 的模块解析形状不同**——
 * 开发机上 `@fominio/dsh-ui` 是 junction，Node/rolldown 会**还原成真实路径**
 * （`apps/fom-client/ui/src/Card.tsx`）；CI 里无论 symlink 还是 junction 都还原不了
 * （`node_modules/@fominio/dsh-ui/src/Card.tsx`）⇒ 产物里的模块注释必然不同。
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

import { existsSync, readdirSync, statSync } from 'node:fs'
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

console.log(failed === 0 ? '\n✓ client 半产物都在' : `\n✗ ${failed} 个插件的 client 半过期`)
process.exit(failed === 0 ? 0 : 1)
