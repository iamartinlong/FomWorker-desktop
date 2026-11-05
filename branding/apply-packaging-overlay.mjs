/**
 * 桌面打包 overlay（阶段2）：把 **FomWorker 品牌插件 + 办公插件**真进打包产物。
 *
 * 用法（桌面仓根）：node branding/apply-packaging-overlay.mjs [内核目录=deepseek-harness] [repoRoot=.]
 * 前置：内核已 `pnpm install`（后续 `package:win:x64:unsigned` 会 build:official 编译被改的 profile.ts）。
 *
 * **关键约束**：运行时树 `dsh/` 被 `desktop-runtime.json` **封了完整文件清单**——smoke 的
 * `verifyRuntimeArchive` 会逐字节比对 ASAR 里的 `dsh/` 与描述符。所以**不能**用 electron-builder 的
 * `files` 往 `dsh/` 里塞文件（会 `ASAR integrity verification failed`）；必须在
 * `writeDesktopRuntime` 写描述符**之前**把文件放进 `DSH_OUTPUT_ROOT/node_modules`。
 * 因此本脚本改的是 `prepare-dsh.ts`（插一步），不是 electron-builder 配置。
 *
 * 三件事（都是**就地改内核树**，内核仓库零提交）：
 *   1. staging：把 bundle / 品牌 / 登录 / 办公插件按 `node_modules/<pkg>` 布局拷进 `.fomworker-overlay/`。
 *      **bundle 的 `cordis.patch.yml` 原样带走**（挂 ui-brand + ui-login + office-* 全行）。
 *   2. prepare-dsh：在 `runtime:manifests` 之前把 staging 的 `@fominfo`/`@office` 拷进运行时 `node_modules`。
 *   3. profile：web 模板的 bundles 追加 `@fominfo/dsh-bundle-fomworker`（desktop profile 据此挂载）。
 *
 * ⚠️ 前置产物：办公插件的 `lib/`（host 半 + browser 半）必须已构建——
 * `pwsh -File apps/fom-client/scripts/build-bundles.ps1` + `node apps/fom-client/scripts/build-host-halves.mjs`。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const BUNDLE = '@fominfo/dsh-bundle-fomworker'

/** 要进运行时的包 → 源目录（相对 repoRoot）。顺序无关。 */
const STAGE = [
  ['@fominfo/dsh-bundle-fomworker', 'apps/fom-client/bundle'],
  ['@fominfo/dsh-client-ui-brand-fomworker', 'apps/fom-client/plugins/ui-brand-fomworker'],
  ['@fominfo/dsh-client-ui-login', 'apps/fom-client/plugins/office-login'],
  ['@office/catalog', 'apps/fom-client/plugins/office-catalog'],
  ['@office/authz', 'apps/fom-client/plugins/office-authz'],
  ['@office/console', 'apps/fom-client/plugins/office-console'],
  ['@office/experts', 'apps/fom-client/plugins/office-experts'],
  ['@office/skills', 'apps/fom-client/plugins/office-skills'],
  ['@office/approval', 'apps/fom-client/plugins/office-approval'],
  ['@office/feishu', 'apps/fom-client/plugins/office-feishu'],
  ['@office/billing', 'apps/fom-client/plugins/office-billing'],
  ['@office/reporter', 'apps/fom-client/plugins/office-reporter'],
  ['@office/channel', 'apps/fom-client/plugins/office-channel'],
  ['@office/delegate', 'apps/fom-client/plugins/office-delegate'],
  ['@office/tasks', 'apps/fom-client/plugins/office-tasks'],
  ['@office/assistant', 'apps/fom-client/plugins/office-assistant'],
]

const kernelRoot = resolve(process.argv[2] ?? 'deepseek-harness')
const repoRoot = resolve(process.argv[3] ?? '.')
const desktopRoot = join(kernelRoot, 'apps', 'desktop')

// 1. staging：按 node_modules/<pkg> 布局拷贝（跳过 node_modules）。
const overlayRoot = join(repoRoot, '.fomworker-overlay')
const stagingModules = join(overlayRoot, 'node_modules')
rmSync(overlayRoot, { recursive: true, force: true })
const skipNodeModules = (src) => !/(?:^|[\\/])node_modules(?:[\\/]|$)/u.test(src)
for (const [pkg, rel] of STAGE) {
  const src = join(repoRoot, rel)
  const dest = join(stagingModules, ...pkg.split('/'))
  mkdirSync(join(dest, '..'), { recursive: true })
  cpSync(src, dest, { recursive: true, filter: skipNodeModules })
  // 护栏：**声明了入口**的包（`main` / `exports["."]`），其产物必须已入库
  // （否则打进安装器的是**加载不了**的包）。纯 bundle 补丁包（`dsh.bundle.patch`）无入口，跳过。
  const manifest = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'))
  const entry = manifest.main ?? manifest.exports?.['.']
  if (entry !== undefined && (typeof entry !== 'string' || !existsSync(join(dest, entry)))) {
    throw new Error(`packaging overlay: ${pkg} 的入口产物缺失（${String(entry)}）——先跑 build-bundles.ps1 / build-host-halves.mjs`)
  }
}

// 2. prepare-dsh：写描述符之前把 staging 的 @fominfo / @office 拷进运行时 node_modules（描述符才会收录）。
//
// ⚠️ 2026-10-24 修一个真缺陷：**不幂等**。
// 原写法直接 `replace(anchor, inserted + anchor)`，第二次运行会**再插一遍**
// （本地实测 prepare-dsh.ts 里出现两段 `runtime:fomworker-overlay`，且第二段缩进来自
// 上一次的拼接结果）。CI 每次全新 clone 不暴露，但本地重放会插重复步骤。
// 现在：有注入痕迹就跳过；锚点必须先断言唯一；写回做逐字节还原校验。
//
// 注：注入里带的是**绝对路径**（`stagingModules` 由 `repoRoot` 解析而来）。这是有意为之——
// overlay 与打包都在仓库根执行，`repoRoot` 默认 `.`，所以 CI 上解析成 `D:/a/...` 也是对的。
// 不要改成相对路径：`prepare-dsh.ts` 的运行 cwd 不保证是仓库根。
const preparePath = join(desktopRoot, 'scripts', 'prepare-dsh.ts')
const prepare = readFileSync(preparePath, 'utf8')
const prepareAnchor = "  await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:manifests', () => prepareRuntimeManifests(DSH_OUTPUT_ROOT))"
if (!prepare.includes(prepareAnchor)) throw new Error('packaging overlay: prepare-dsh.ts anchor not found')

/** 幂等标记：注入块里的独特步骤名。 */
const PREPARE_MARKER = "'runtime:fomworker-overlay'"

if (prepare.includes(PREPARE_MARKER)) {
  console.log('packaging overlay: prepare-dsh.ts 已含 fomworker-overlay 步骤，跳过')
} else {
  const scopes = ['@fominfo', '@office']
    .map((scope) => join(stagingModules, scope).replaceAll('\\', '/'))
  const inserted = `  await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:fomworker-overlay', async () => {\n`
    + scopes.map((from) => `    cpSync(${JSON.stringify(from)}, join(DSH_OUTPUT_ROOT, 'node_modules', ${JSON.stringify(from.split('/').at(-1))}), { recursive: true, dereference: true })\n`).join('')
    + `  })\n`

  // 锚点必须唯一：它前面还有别的 packagingStep，重复命中就会插两处。
  const anchorCount = prepare.split(prepareAnchor).length - 1
  if (anchorCount !== 1) {
    throw new Error(
      `packaging overlay: prepare-dsh.ts 的 runtime:manifests 锚点出现 ${String(anchorCount)} 次，预期 1 次 —— 拒绝写文件。`,
    )
  }

  const next = prepare.replace(prepareAnchor, `${inserted}${prepareAnchor}`)
  // 逐字节还原校验：挖掉注入块必须还原原文。
  if (next.replace(`${inserted}${prepareAnchor}`, prepareAnchor) !== prepare) {
    throw new Error('packaging overlay: prepare-dsh.ts 替换越界，拒绝写文件。')
  }
  writeFileSync(preparePath, next)
  console.log(`packaging overlay: prepare-dsh.ts 插入 fomworker-overlay 步骤 → ${preparePath}`)
}

// 3. profile：web 模板 bundles 追加品牌 bundle。
//
// ⚠️ 2026-10-24 事故：这里原来只认一种文件形态 ——
//   `packages/boot/app-boot/src/profile.ts` 里的字面量
//   `bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],`
// `pkg-26` 的 CI 报 `profile.ts web anchor not found`，而**这是全新 clone**，不是幂等！
// 真因：上游把 profile 模板整体搬进了独立包
//   `packages/util/official-bundles/src/bundles.ts` 的 `PROFILE_TEMPLATES`，
// `profile.ts` 改为 `import { PROFILE_TEMPLATES } from '@deepseek-ai/dsh-official-bundles'`，
// 原来那个字面量数组**在这个文件里彻底消失**。
//
// ⇒ 现在按「哪个文件在就用哪个」处理两种形态，并且：
//   - 两种都不在 ⇒ 报错并列出实际找到的候选行（不猜）；
//   - 目标文本必须**恰好出现 1 次**，否则报错（避免改错位置）。
// 教训同知识库 §2.18：锚点要钉在**语义**上，而不是「某个文件里的某行」。
const PROFILE_TARGETS = [
  // 旧结构：模板内联在 apps/boot 的 profile.ts 里。
  {
    path: join(kernelRoot, 'packages', 'boot', 'app-boot', 'src', 'profile.ts'),
    anchor: "    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],",
  },
  // 新结构（22ddee37 起）：模板搬到 official-bundles 包的 PROFILE_TEMPLATES。
  {
    path: join(kernelRoot, 'packages', 'util', 'official-bundles', 'src', 'bundles.ts'),
    anchor: "    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],",
  },
]

const presentTargets = PROFILE_TARGETS.filter((target) => existsSync(target.path))
if (presentTargets.length === 0) {
  throw new Error(
    'packaging overlay: 找不到放 profile 模板的文件（新旧两种位置都不存在）。\n'
    + PROFILE_TARGETS.map((target) => `    期望：${target.path}`).join('\n'),
  )
}

/** 已经注入过（早先运行留下的痕迹）⇒ 跳过这一步，保持幂等。 */

let profileWired = false
for (const target of presentTargets) {
  const text = readFileSync(target.path, 'utf8')
  if (text.includes(BUNDLE)) {
    console.log(`packaging overlay: ${target.path} 已含 ${BUNDLE}，跳过 profile 注入`)
    profileWired = true
    break
  }
  if (!text.includes(target.anchor)) continue

  const occurrences = text.split(target.anchor).length - 1
  if (occurrences !== 1) {
    throw new Error(
      `packaging overlay: ${target.path} 里 web 模板锚点出现 ${String(occurrences)} 次，预期 1 次。\n`
      + `  锚点不唯一时本脚本拒绝写文件。锚点：${JSON.stringify(target.anchor)}`,
    )
  }

  const next = text.replace(
    target.anchor,
    `    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '${BUNDLE}'],`,
  )
  // 逐字节还原校验：把改动挖掉必须还原原文（同 apply-data-isolation-build 的做法）。
  if (next.replace(`    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '${BUNDLE}'],`, target.anchor) !== text) {
    throw new Error(`packaging overlay: ${target.path} 替换越界，拒绝写文件。`)
  }
  writeFileSync(target.path, next)
  console.log(`packaging overlay: web 模板追加 ${BUNDLE} → ${target.path}`)
  profileWired = true
  break
}

if (!profileWired) {
  // 目标文件在、但没有命中锚点、也没有已注入痕迹 ⇒ 上游又改了模板写法。打印线索，不猜。
  const hints = presentTargets
    .map((target) => {
      const text = readFileSync(target.path, 'utf8')
      const related = text.split('\n')
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => line.includes('dsh-web-app'))
        .map(({ line, number }) => `      行${String(number)}: ${line.trim()}`)
        .join('\n')
      return `    ${target.path}：\n${related === '' ? '      (该文件里没有 dsh-web-app)' : related}`
    })
    .join('\n')
  throw new Error(`packaging overlay: web 模板锚点未命中，且未见已注入痕迹。\n${hints}`)
}

console.log(`packaging overlay: staged ${STAGE.length} packages + wired ${BUNDLE} into the desktop runtime`)
