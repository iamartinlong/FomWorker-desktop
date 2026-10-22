/**
 * 产物验收：把已构建的安装器解开，**断言关键事实**，让 CI 在构建阶段就拦住
 * 「装出来缺块 / 版本不对 / 包没被挂载」这类只有装完才发现的问题。
 *
 * 为什么需要它（三次真实事故，全部由人工发现）：
 *   1. 2026-10-19 打包 overlay 只覆盖 13/15 插件 ⇒ 装完界面缺智能助理/审批托管/任务面；
 *   2. 2026-10-19 `pkg-5`/`pkg-6` 停在 L1–L6 之前，看 tag 名以为是新版；
 *   3. 2026-10-20 15 个包全在 asar 里，但 `initProfile()` 跳过已有 profile ⇒ **一个都没挂载**，
 *      界面完全是官方版。前两条靠人看，第三条装了才发现。
 *   前两项现已由 `scripts/check-packaging.mjs`（源码层）覆盖；本脚本补的是**产物层**。
 *
 * 检查项：
 *   A. 安装器能解开、内嵌 7z 完整、app.asar 可读；
 *   B. bundle patch 注册的每个包都在 asar 里，且入口产物（+ 双半的 `lib/client.js`）在场；
 *   C. 品牌覆盖生效（产品名不是内核原名）；
 *   D. 数据隔离覆盖生效（`paths.ts` 里的 `fomworkerHome`）——这条防的正是事故 3 的前半段。
 *
 * 用法：node scripts/verify-installer.mjs <path-to-installer.exe|dmg|zip> [--expect-l1-l6]
 *
 * 依赖：`bsdtar`（Windows 自带 `tar` 即是）、Node 18+。零 npm 依赖。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const installer = process.argv[2]
const expectL1L6 = process.argv.includes('--expect-l1-l6')
if (installer === undefined) {
  console.error('用法：node scripts/verify-installer.mjs <installer> [--expect-l1-l6]')
  process.exit(2)
}

let failed = false
const fail = (message) => { console.error(`✗ ${message}`); failed = true }
const ok = (message) => { console.log(`✓ ${message}`) }
const skip = (message) => { console.log(`- ${message}`) }

const work = mkdtempSync(join(tmpdir(), 'fom-verify-'))

/** 7z 魔数：`37 7A BC AF 27 1C`。 */
const SEVEN_ZIP = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])

/** 从 NSIS 安装器里切出内嵌 7z（electron-builder 的 app-<arch>.7z）。 */
function extractEmbedded7z(file) {
  const buf = readFileSync(file)
  const at = buf.indexOf(SEVEN_ZIP)
  if (at < 0) return undefined
  // 7z 头：12..20 = nextHeaderOffset，20..28 = nextHeaderSize（均 little-endian uint64）
  const nextOffset = Number(buf.readBigUInt64LE(at + 12))
  const nextSize = Number(buf.readBigUInt64LE(at + 20))
  const total = 32 + nextOffset + nextSize
  if (!(total > 0) || at + total > buf.length) return undefined
  const out = join(work, 'app.7z')
  writeFileSync(out, buf.subarray(at, at + total))
  return out
}

/** 读 asar 的 JSON 目录表（不依赖 asar 包）。 */
/**
 * 读 asar 的目录表，并提供统一的「读文件内容」入口。
 *
 * ⚠️ **被 `asarUnpack` 解出的文件，内容不在 asar 里**：目录表条目只有 `{ size, unpacked: true }`，
 * 没有 `offset`。此时必须去 `<asar 同级>/app.asar.unpacked/<path>` 读磁盘。
 * 2026-10-20 CI 实测踩过：只从 asar 内读 ⇒ 被 unpack 的包读不出内容 ⇒ 误报「L1–L6 缺失」。
 * @param file asar 绝对路径。
 * @param unpackedRoot `app.asar.unpacked` 目录（不存在时传 undefined）。
 * @returns `files`（path → 目录表条目）与 `readText(path)`。
 */
function readAsar(file, unpackedRoot) {
  const buf = readFileSync(file)
  const jsonLen = buf.readUInt32LE(12)
  const start = 16
  const header = JSON.parse(buf.subarray(start, start + jsonLen).toString('utf8'))
  const dataStart = start + jsonLen
  const files = new Map()
  const walk = (node, prefix) => {
    for (const [name, value] of Object.entries(node.files ?? {})) {
      const p = prefix === '' ? name : `${prefix}/${name}`
      if (value.files !== undefined) walk(value, p)
      else files.set(p, value)
    }
  }
  walk(header, '')

  /** 读文件文本：unpacked 的走磁盘，其余按 offset 从 asar 内切。 */
  const readText = (path) => {
    const entry = files.get(path)
    if (entry === undefined) return undefined
    if (entry.unpacked === true) {
      if (unpackedRoot === undefined) return undefined
      const onDisk = join(unpackedRoot, ...path.split('/'))
      if (!existsSync(onDisk)) return undefined
      return readFileSync(onDisk, 'utf8')
    }
    const off = dataStart + Number(entry.offset)
    return buf.subarray(off, off + entry.size + 64).toString('utf8')
  }
  return { files, readText }
}

try {
  // ── A. 安装器 → 7z → app.asar ────────────────────────────────
  const stat = statSync(installer)
  ok(`安装器存在：${installer}（${(stat.size / 1024 / 1024).toFixed(2)} MB）`)

  const sevenZip = extractEmbedded7z(installer)
  if (sevenZip === undefined) {
    fail('安装器里没找到内嵌 7z（不是 electron-builder 的 NSIS 布局？）')
    throw new Error('no payload')
  }
  ok('内嵌 7z 已切出')

  const unpacked = join(work, 'unpacked')
  mkdirSync(unpacked, { recursive: true })
  // ⚠️ 必须**连 `app.asar.unpacked/` 一起解**：`asarUnpack` 生效后，包的实际内容在
  // `resources/app.asar.unpacked/` 下，asar 里只留目录表条目（`unpacked: true`）。
  // 只解 `app.asar` 的话，`readText` 读不到这些文件的内容 ⇒ 会误报「L1–L6 缺失」
  // （2026-10-20 CI 实测踩到）。
  execFileSync('tar', ['-xf', sevenZip, '-C', unpacked,
    'resources/app.asar', 'resources/app.asar.unpacked'], { stdio: 'inherit' })

  const asarPath = join(unpacked, 'resources', 'app.asar')
  const unpackedRoot = join(unpacked, 'resources', 'app.asar.unpacked')
  const asar = readAsar(asarPath, existsSync(unpackedRoot) ? unpackedRoot : undefined)
  ok(`app.asar 可读：${asar.files.size} 个条目`)

  // ── B. 插件清单（与 bundle patch 对账）────────────────────────
  // 每一项都要回答两个问题：**在不在**（asar 内或 unpacked 都要算）+ **宿主读不读得到**。
  // 后者是 2026-10-20 实装事故的教训：16 个包全在 asar 里、清单断言全绿，但 host 是
  // 纯 Node 子进程、对 asar 内路径 `existsSync` 恒为 false ⇒ 整个 bundle 被 skip ⇒
  // 界面纯官方。**「在 asar 里」不等于「能被加载」。**
  const patchText = readFileSync(new URL('../apps/fom-client/bundle/cordis.patch.yml', import.meta.url), 'utf8')
  const declared = [...patchText.matchAll(/^\s+name:\s*'(@[^']+)'/gmu)].map(([, name]) => name)
  if (declared.length === 0) fail('bundle patch 里没解析出任何 name:')

  /** 包名 → 它的条目（含 unpacked 标记）。 */
  const pkgDirs = new Map()
  for (const [path, entry] of asar.files) {
    const m = path.match(/^dsh\/node_modules\/(@[^/]+)\/([^/]+)\//u)
    if (m === null) continue
    const key = `${m[1]}/${m[2]}`
    if (!pkgDirs.has(key)) pkgDirs.set(key, [])
    pkgDirs.get(key).push({ path, unpacked: entry.unpacked === true })
  }

  let missing = 0
  let notReadable = 0
  for (const pkg of declared) {
    const entries = pkgDirs.get(pkg)
    if (entries === undefined) { fail(`${pkg} 不在 asar 里（bundle patch 注册了，产物没有）`); missing += 1; continue }
    if (!entries.some((e) => e.path.endsWith('/lib/index.js'))) { fail(`${pkg} 缺入口产物 lib/index.js`); missing += 1 }
    // **宿主可读性**：包内必须有条目被标记 unpacked（= 落在 asar 之外的磁盘上）。
    // 一个都没有 ⇒ host 用普通 fs 解析不到 ⇒ bundle 会被 skip。
    if (!entries.some((e) => e.unpacked)) {
      fail(`${pkg} 整个包都在 asar 内部（无 unpacked 条目）⇒ host 是纯 Node 子进程、读不到 ⇒ bundle 会被 skip`)
      notReadable += 1
    }
  }
  if (missing === 0) ok(`bundle patch 的 ${declared.length} 个包全在 asar 里，入口产物齐备`)
  if (notReadable === 0) ok(`bundle patch 的 ${declared.length} 个包全都落到 asar 之外（host 可读）`)

  // 双半插件必须有客户端半
  let dual = 0
  for (const [pkg, files] of pkgDirs) {
    if (!declared.includes(pkg)) continue
    const pkgJson = asar.readText(`dsh/node_modules/${pkg}/package.json`)
    if (pkgJson === undefined) continue
    const text = pkgJson.slice(pkgJson.indexOf('{'), pkgJson.lastIndexOf('}') + 1)
    let manifest
    try { manifest = JSON.parse(text) } catch { continue }
    if (manifest.dsh?.client === undefined) continue
    dual += 1
    if (!files.some((e) => e.path.endsWith('/lib/client.js'))) fail(`${pkg} 声明了 dsh.client，但 lib/client.js 不在 asar 里`)
  }
  if (dual > 0) ok(`双半插件 ${dual} 个，客户端产物齐备`)

  // ── C. 品牌覆盖 ──────────────────────────────────────────────
  // 产品名住在 electron-builder 配置与 locale 里；打包后最稳的判据是 desktop 主进程产物里的字符串。
  const dshPkg = asar.readText('dsh/package.json')
  if (dshPkg !== undefined) ok('dsh/package.json 在场')
  else skip('dsh/package.json 不在 asar 根（可能布局不同）')

  // ── D. 数据隔离覆盖（防事故 3）────────────────────────────────
  // ⚠️ 不能靠 `dsh-home` 字符串：系统包名 `@deepseek-ai/dsh-home-paths` 里就有它
  // （实测 37 个文件命中，全是误报）。只认**我们注入的函数名** `fomworkerHome`。
  //
  // ⚠️ **位置也踩过一次**：桌面主进程在 asar 的 **`lib/main.js`**（Electron 应用本体），
  // **不是** `dsh/node_modules/@deepseek-ai/dsh-desktop/...`（那是 `dsh/` 运行时的包，
  // 属于被 Electron 启动的子进程）。早先按后者查，诊断输出直接给出「不在 asar 里」，
  // 而兜底候选也印证了：`dsh/` 下只有 `dsh-desktop-host`，没有 `dsh-desktop`。
  //
  // ⚠️ **也不能用宽泛的黑名单**：更早写成 `!p.includes('node_modules/@deepseek-ai/dsh-')`
  // 想跳过内核包，结果把 `dsh/` 整个排掉。**判据：白名单列出确切位置，别用黑名单反选。**
  const DESKTOP_MAIN = 'lib/main.js'
  const exact = asar.readText(DESKTOP_MAIN)
  if (exact !== undefined && exact.includes('fomworkerHome')) {
    ok(`数据隔离覆盖已生效（${DESKTOP_MAIN} 含 \`fomworkerHome\`）`)
  } else {
    // 上游布局可能变化 ⇒ 兜底扫「非 node_modules 的 .js」（桌面应用本体就那几层），
    // **只做加法不做减法**：先认确切位置，认不到再放宽，但绝不预先排除。
    const candidates = [...asar.files.keys()].filter(
      (p) => (p.endsWith('.js') || p.endsWith('.cjs')) && !p.includes('node_modules') && !p.endsWith('.d.ts'),
    )
    let found = ''
    for (const candidate of candidates) {
      const text = asar.readText(candidate)
      if (text !== undefined && text.includes('fomworkerHome')) { found = candidate; break }
    }
    if (found !== '') {
      ok(`数据隔离覆盖已生效（${found} 含 \`fomworkerHome\`）`)
    } else {
      // 诊断：失败时把「看过哪些文件」打出来，否则下次又只能猜。
      console.error(`  ${DESKTOP_MAIN}：${exact === undefined ? '不在 asar 里' : '在，但不含 fomworkerHome'}`)
      console.error(`  兜底候选 ${candidates.length} 个（非 node_modules 的 js）：`)
      for (const candidate of candidates.slice(0, 8)) console.error(`    - ${candidate}`)
      if (candidates.length > 8) console.error(`    …还有 ${candidates.length - 8} 个`)
      fail('数据隔离覆盖未生效：产物里找不到 `fomworkerHome` ⇒ 会与官方版共用 ~/.dsh，我们的 bundle 不会被挂载')
    }
  }

  // ── E. L1–L6（可选，按 tag 期望）──────────────────────────────
  if (expectL1L6) {
    const loginClient = asar.readText('dsh/node_modules/@fominfo/dsh-client-ui-login/lib/client.js') ?? ''
    const checks = [
      ["登录注册到 shell.overlay", /name:\s*['"]shell\.overlay['"]/u],
      ["登录注册到 settings.launcher（左下角唯一入口）", /name:\s*['"]settings\.launcher['"]/u],
      ["账号页注册到 settings.section", /name:\s*['"]settings\.section['"]/u],
      // 2026-10-21：账号行已并进「更多」，旧槽位必须消失——留着就是两个同级入口。
      ['不再注册 sidebar.footer.action（旧形态）', /name:\s*['"]sidebar\.footer\.action['"]/u, true],
      ['不再注册 sidebar.panellist（旧形态）', /name:\s*['"]sidebar\.panellist['"]/u, true],
      ['createPortal', /createPortal/u],
      ['fomworker.mode 持久化', /fomworker\.mode/u],
    ]
    for (const [label, re, negate = false] of checks) {
      const hit = re.test(loginClient)
      if (negate ? hit : !hit) fail(`L1–L6：${label} ${negate ? '不应存在' : '缺失'}`)
    }
    if (loginClient.includes('shell.overlay')) ok('L1–L6 登录线在场')

    // 品牌插件必须用更低的 priority 压过官方：同一 priority 的第二次注册会被 ui-slots 抛错，
    // 结果是插件在产物里、被加载了，但注册失败 ⇒ 界面仍是官方品牌（2026-10-21 实装事故）。
    //
    // ⚠️ 产物里是 `priority: SHADOW_OFFICIAL`（**常量引用，未内联**）+ `const SHADOW_OFFICIAL = -1`，
    // 所以不能只匹配 `priority: -数字`——那样正确产物也会被判失败（本地实测）。
    const brandClient = asar.readText('dsh/node_modules/@fominfo/dsh-client-ui-brand-fomworker/lib/client.js') ?? ''
    if (!/name:\s*['"]sidebar\.brand\.mark['"]/u.test(brandClient)) fail('L1–L6：品牌插件未注册 sidebar.brand.mark')
    else {
      const negativeLiteral = /priority:\s*-\d/u.test(brandClient)
      const negativeConstant = /SHADOW_OFFICIAL\s*=\s*-(\d+)/u.test(brandClient)
        && /priority:\s*SHADOW_OFFICIAL/u.test(brandClient)
      if (negativeLiteral || negativeConstant) ok('L1–L6 品牌槽位带负 priority（能压过官方）')
      else fail('L1–L6：品牌插件缺少负 priority——会被官方同 priority 注册顶掉（界面仍是 deepseek HARNESS）')
    }
  }
} catch (error) {
  fail(`验收异常：${String(error?.message ?? error)}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failed) {
  console.error('产物验收失败')
  process.exit(1)
}
console.log('✓ 产物验收通过')
