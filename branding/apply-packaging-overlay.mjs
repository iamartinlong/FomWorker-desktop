/**
 * 桌面打包 overlay（阶段2 v1）：把 **FomWorker 品牌插件**真进打包产物。
 *
 * 用法（桌面仓根）：node branding/apply-packaging-overlay.mjs [内核目录=deepseek-harness] [repoRoot=.]
 * 前置：内核已 `pnpm install`（后续 `package:win:x64:unsigned` 会 build:official 编译被改的 profile.ts）。
 *
 * 做三件事（都是**就地改内核树**，内核仓库零提交）：
 *   1. staging：把品牌包拷成 `node_modules/@fominfo/*` 布局；bundle 的 patch 收成「仅品牌」行
 *      （办公插件是 `.ts`、打包产物无 tsx，v1 先不进）。
 *   2. electron-builder：加一条 `files` 把 staging 的 `@fominfo/*` 并进 `dsh/node_modules`。
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

// 2. electron-builder：把 staging 的 @fominfo 并进 dsh/node_modules。
const configPath = join(desktopRoot, 'scripts', 'electron-builder-config.mjs')
let config = readFileSync(configPath, 'utf8')
const configAnchor = "      { from: join(buildPaths.dsh, 'node_modules'), to: 'dsh/node_modules', filter: ['**/*'] },"
if (!config.includes(configAnchor)) throw new Error('packaging overlay: electron-builder files anchor not found')
const fromDir = join(stagingModules, '@fominfo').replaceAll('\\', '/')
config = config.replace(configAnchor,
  `${configAnchor}\n      { from: ${JSON.stringify(fromDir)}, to: 'dsh/node_modules/@fominfo', filter: ['**/*'] },`)
writeFileSync(configPath, config)

// 3. profile：web 模板 bundles 追加品牌 bundle。
const profilePath = join(kernelRoot, 'packages', 'boot', 'app-boot', 'src', 'profile.ts')
let profile = readFileSync(profilePath, 'utf8')
const profileAnchor = "    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],"
if (!profile.includes(profileAnchor)) throw new Error('packaging overlay: profile.ts web anchor not found')
profile = profile.replace(profileAnchor, `    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '${BUNDLE}'],`)
writeFileSync(profilePath, profile)

console.log(`packaging overlay: wired ${BUNDLE} + ${BRAND} into the desktop runtime`)
