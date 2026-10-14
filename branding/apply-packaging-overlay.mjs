/**
 * 桌面打包 overlay（阶段2 v1）：把 **FomWorker 品牌插件**真进打包产物。
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
 *   1. staging：品牌包拷成 `node_modules/@fominfo/*` 布局；bundle 的 patch 收成「仅品牌」行
 *      （办公插件是 `.ts`、打包运行时无 tsx，v1 先不进）。
 *   2. prepare-dsh：在 `runtime:manifests` 之前把 staging 的 `@fominfo/*` 拷进运行时 `node_modules`。
 *   3. profile：web 模板的 bundles 追加 `@fominfo/dsh-bundle-fomworker`（desktop profile 据此挂载）。
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const BUNDLE = '@fominfo/dsh-bundle-fomworker'
const BRAND = '@fominfo/dsh-client-ui-brand-fomworker'

const kernelRoot = resolve(process.argv[2] ?? 'deepseek-harness')
const repoRoot = resolve(process.argv[3] ?? '.')
const desktopRoot = join(kernelRoot, 'apps', 'desktop')

// 1. staging：node_modules/@fominfo 布局 + 品牌-only bundle patch。
const overlayRoot = join(repoRoot, '.fomworker-overlay')
const stagingModules = join(overlayRoot, 'node_modules')
rmSync(overlayRoot, { recursive: true, force: true })
mkdirSync(join(stagingModules, '@fominfo'), { recursive: true })
const skipNodeModules = (src) => !/(?:^|[\\/])node_modules(?:[\\/]|$)/u.test(src)
cpSync(join(repoRoot, 'apps', 'fom-client', 'bundle'), join(stagingModules, '@fominfo', 'dsh-bundle-fomworker'), { recursive: true, filter: skipNodeModules })
cpSync(join(repoRoot, 'apps', 'fom-client', 'plugins', 'ui-brand-fomworker'), join(stagingModules, '@fominfo', 'dsh-client-ui-brand-fomworker'), { recursive: true, filter: skipNodeModules })
writeFileSync(join(stagingModules, '@fominfo', 'dsh-bundle-fomworker', 'cordis.patch.yml'),
  `# 打包产物用的品牌-only bundle patch（办公插件是 .ts，无 tsx 的打包运行时加载不了）。\n- insert:\n    - id: ui-brand-fomworker\n      name: '${BRAND}'\n`)

// 2. prepare-dsh：写描述符之前把 staging 的 @fominfo 拷进运行时 node_modules（描述符才会收录）。
const preparePath = join(desktopRoot, 'scripts', 'prepare-dsh.ts')
const prepare = readFileSync(preparePath, 'utf8')
const prepareAnchor = "  await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:manifests', () => prepareRuntimeManifests(DSH_OUTPUT_ROOT))"
if (!prepare.includes(prepareAnchor)) throw new Error('packaging overlay: prepare-dsh.ts anchor not found')
const fromDir = join(stagingModules, '@fominfo').replaceAll('\\', '/')
const inserted = `  await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'runtime:fomworker-overlay', async () => {\n`
  + `    cpSync(${JSON.stringify(fromDir)}, join(DSH_OUTPUT_ROOT, 'node_modules', '@fominfo'), { recursive: true, dereference: true })\n`
  + `  })\n`
writeFileSync(preparePath, prepare.replace(prepareAnchor, `${inserted}${prepareAnchor}`))

// 3. profile：web 模板 bundles 追加品牌 bundle。
const profilePath = join(kernelRoot, 'packages', 'boot', 'app-boot', 'src', 'profile.ts')
const profile = readFileSync(profilePath, 'utf8')
const profileAnchor = "    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],"
if (!profile.includes(profileAnchor)) throw new Error('packaging overlay: profile.ts web anchor not found')
writeFileSync(profilePath, profile.replace(profileAnchor, `    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '${BUNDLE}'],`))

console.log(`packaging overlay: wired ${BUNDLE} + ${BRAND} into the desktop runtime`)
