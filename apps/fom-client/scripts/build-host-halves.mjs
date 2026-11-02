/**
 * 把 host-only 的 office 插件（catalog / authz / console / experts / skills）的 `index.ts`
 * 构建成 `lib/index.js`。
 *
 * 为什么需要：**打包运行时没有 tsx**，Loader 只能加载 JS ⇒ host 半必须出产物
 * （插件 `package.json` 的 `exports["."]` 指向 `lib/index.js`）。esbuild 只转译、**不做类型检查**
 * （类型由 `tsc -p apps/fom-client/tsconfig.json` 覆盖）；**裸导入全部外部化**（运行时经 node_modules 解析），
 * 相对导入内联（都是纯函数/纯类型，无共享状态）。
 *
 * 改了这些插件的 host 源码（`index.ts` 及其相对依赖）后必须重跑。
 */

import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginsDir = join(here, '..', 'plugins')
// 固定工作目录 ⇒ esbuild 写进产物的 `// <相对路径>` 注释稳定（否则随调用时的 cwd 变，产物反复抖动）。
const workingDir = join(here, '..', '..', '..')

/** host 半需要产物的插件（browser-only 的另有 tsdown 链）。 */
const HOST_ONLY = ['office-catalog', 'office-authz', 'office-console', 'office-experts', 'office-skills', 'office-approval', 'office-feishu', 'office-billing', 'office-reporter', 'office-channel', 'office-delegate', 'office-tasks']

for (const name of HOST_ONLY) {
  const dir = join(pluginsDir, name)
  const outDir = join(dir, 'lib')
  mkdirSync(outDir, { recursive: true })
  await build({
    entryPoints: [join(dir, 'index.ts')],
    outfile: join(outDir, 'index.js'),
    absWorkingDir: workingDir,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    packages: 'external',
    sourcemap: false,
    logLevel: 'warning',
  })
  console.log(`${name}: lib/index.js ← index.ts`)
}

console.log('完成。')
