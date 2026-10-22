/**
 * 让 FomWorker 的 16 个运行时包**落到 asar 之外**（`app.asar.unpacked/dsh/node_modules/`）。
 *
 * ## 为什么必须这样做（2026-10-20 实装事故，根因链完整）
 *
 * 装完 `pkg-11` 界面仍是纯官方版。逐层查下来：
 *
 * 1. `DSH_HOME` 隔离**是生效的**（home 在 `<userData>/dsh-home`）；
 * 2. profile 的 `dsh.profile.bundles` **也含** `@fominfo/dsh-bundle-fomworker`；
 * 3. 但该 bundle 在加载时被记进 `skippedBundles`——它引用的 16 个包**解析不到**。
 *
 * 根因是**两条路径语义不一致**：
 *
 * - `main.ts` 的 `runtimeResources().dsh` = `join(app.getAppPath(), 'dsh')`，
 *   打包后即 **`app.asar/dsh`**（asar **内部**路径）；
 * - 而 `profile.ts` 的 `resolveBundleDir()` 用 `createRequire(anchor).resolve.paths()`
 *   + **`existsSync`** 去找包——host 是 **纯 Node 子进程**（`spawn(node)`，无 Electron
 *   的 asar 补丁）⇒ 对 asar 内路径 `existsSync` 恒为 `false` ⇒ 解析失败。
 *
 * 内核自己的包不受影响：它们**本来就在磁盘上**（`app.asar.unpacked/dsh/node_modules/`，
 * 由上游的 `asarUnpack` 规则按二进制/特殊路径解出）。
 *
 * ⇒ 我们的包是**纯 JS**，默认只会留在 asar 内，于是必然走不通。
 *
 * ## 为什么用 `asarUnpack`（而不是装进 profile 或搬走 `dsh/`）
 *
 * - **符合上游设计意图**：`resolveBundleDir` 是「安装锚点优先、profile 次之」，
 *   即**随安装分发的 bundle 就该在安装目录里**。`asarUnpack` 正是「随安装分发但
 *   需要普通 fs 访问」的标准手段——上游自己就这么用（ripgrep 的 bin/rg、
 *   libreoffice-kit 的整包通配、所有 .node 文件）。
 * - **不动 `dsh/` 的文件清单**：`desktop-runtime.json` 由 `verifyRuntimeArchive` 逐字节
 *   校验，`asarUnpack` 不改变清单内容（只是把同样的字节放到磁盘而非 asar 内）。
 * - **无运行时副作用**：不像「启动时 pnpm install」那样引入首次启动耗时、网络、
 *   权限、离线/代理等故障面；`project-manager.ts` 也明确声明
 *   「prepare the external plugin profile **without installing packages**」。
 *
 * ## 实现要点
 *
 * 直接在 `electron-builder-config.mjs` 的 `unpack` 数组里追加两条按 scope 的通配：
 *
 *    **\/node_modules/@fominfo/**\/*
 *    **\/node_modules/@office/**\/*
 *
 * 用 `@scope/**` 而非逐个包名：新增办公插件时不必回来改这里（当前 16 个包若有增减，
 * 规则自动覆盖），也就不会重演「`STAGE` 与 bundle patch 两处手工维护、漏了三个包」
 * 那类事故。
 *
 * 幂等：已含锚点则跳过。
 *
 * 用法（桌面仓根）：node branding/apply-asar-unpack.mjs [内核目录=deepseek-harness]
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const kernelRoot = resolve(process.argv[2] ?? 'deepseek-harness')
const configPath = join(kernelRoot, 'apps', 'desktop', 'scripts', 'electron-builder-config.mjs')

/** 锚点：`unpack` 数组的最后一行（libreoffice 那条，以反引号模板结尾）。 */
const ANCHOR = '    `**/node_modules/@deepseek-ai/libreoffice-kit-${resolvedPlatform}-${resolvedArch}/**/*`]'

/** 追加：两条按 scope 的通配。用真实换行以免破坏模板串。 */
const APPEND = `    \`**/node_modules/@deepseek-ai/libreoffice-kit-\${resolvedPlatform}-\${resolvedArch}/**/*\`,
    // FomWorker：运行时插件必须落在 asar 之外——host 是纯 Node 子进程，
    // 对 \`app.asar/dsh\` 这类 asar 内路径 \`existsSync\` 恒为 false（见 branding/apply-asar-unpack.mjs）。
    '**/node_modules/@fominfo/**/*',
    '**/node_modules/@office/**/*']`

const source = await readFile(configPath, 'utf8')

if (source.includes("'**/node_modules/@fominfo/**/*'")) {
  console.log('asar unpack: already applied, skipping')
  process.exit(0)
}

if (!source.includes(ANCHOR)) {
  throw new Error(`asar unpack: anchor not found in ${configPath}`)
}

await writeFile(configPath, source.replace(ANCHOR, APPEND))
console.log(`asar unpack: @fominfo/** + @office/** → asar-unpacked (patched ${configPath})`)
