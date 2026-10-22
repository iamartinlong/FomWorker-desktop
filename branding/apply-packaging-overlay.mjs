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
const preparePath = join(desktopRoot, 'scripts', 'prepare-dsh.ts')
const prepare = readFileSync(preparePath, 'utf8')
const prepareAnchor = "  await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:manifests', () => prepareRuntimeManifests(DSH_OUTPUT_ROOT))"
if (!prepare.includes(prepareAnchor)) throw new Error('packaging overlay: prepare-dsh.ts anchor not found')
const scopes = ['@fominfo', '@office']
  .map((scope) => join(stagingModules, scope).replaceAll('\\', '/'))
const inserted = `  await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:fomworker-overlay', async () => {\n`
  + scopes.map((from) => `    cpSync(${JSON.stringify(from)}, join(DSH_OUTPUT_ROOT, 'node_modules', ${JSON.stringify(from.split('/').at(-1))}), { recursive: true, dereference: true })\n`).join('')
  + `  })\n`
writeFileSync(preparePath, prepare.replace(prepareAnchor, `${inserted}${prepareAnchor}`))

// 3. profile：web 模板 bundles 追加品牌 bundle。
const profilePath = join(kernelRoot, 'packages', 'boot', 'app-boot', 'src', 'profile.ts')
const profile = readFileSync(profilePath, 'utf8')
const profileAnchor = "    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],"
if (!profile.includes(profileAnchor)) throw new Error('packaging overlay: profile.ts web anchor not found')
writeFileSync(profilePath, profile.replace(profileAnchor, `    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '${BUNDLE}'],`))

console.log(`packaging overlay: staged ${STAGE.length} packages + wired ${BUNDLE} into the desktop runtime`)
