/**
 * 发布工作流（CD）的结构校验（零依赖，但尽量用真解析器）。
 *
 * ## 为什么需要它（2026-10-21 加 CD 时两次踩到）
 *
 * 1. **`download-artifact` 保留上传时的相对路径**：上传的是
 *    `deepseek-harness/apps/…/unsigned-artifacts/*.exe`，取回后文件在
 *    `dist/deepseek-harness/apps/…/*.exe`。第一版写 `gh release create dist/*.exe`，
 *    根本匹配不到 ⇒ Release 里一个安装器都没有，而 workflow 仍然「成功」。
 * 2. **`--notes "…`反引号`…"`**：bash 双引号内的反引号是命令替换，会被执行。
 *
 * 这两类错误都不会在本地暴露（本地不跑 workflow），只会在真正的 Release 上显形。
 * 所以把「结构必须满足的形状」钉成静态断言。
 *
 * ## 判据
 *
 * 1. `release` job 必须 `needs` 打包 job（验收全绿后才发布）；
 * 2. 写权限只出现在 `release` job 上，顶层必须是 read（最小权限）；
 * 3. 发布命令必须用 `--notes-file`（不把 markdown 塞进 shell 双引号）；
 * 4. 汇总脚本必须先摊平 `download` 的嵌套路径，且对「一个制品都没有」显式失败；
 * 5. 每个 `run:` 里不得出现裸反引号（会被 bash 当命令替换）。
 *
 * 用法（产品仓根）：node scripts/check-release-workflow.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const path = '.github/workflows/package.yml'
let failed = false
const ok = (message) => { console.log('✓ ' + message) }
const fail = (message) => { console.error('✗ ' + message); failed = true }

/** 优先用真 YAML 解析器：正则读 workflow 会在缩进/引号上出错。 */
function loadWorkflow() {
  const source = readFileSync(join(root, path), 'utf8')
  const candidates = [
    'deepseek-harness/node_modules/.pnpm/js-yaml@4.2.0/node_modules/js-yaml',
    'deepseek-harness/node_modules/js-yaml',
  ]
  for (const candidate of candidates) {
    const absolute = join(root, candidate)
    if (!existsSync(absolute + '.js') && !existsSync(join(absolute, 'index.js'))) continue
    try {
      // eslint-disable-next-line ts/no-require-imports -- 运行时探测可用解析器
      const yaml = createRequire(import.meta.url)(absolute)
      return { doc: (yaml.load ?? yaml.parse)(source), source }
    } catch { /* 试下一个 */ }
  }
  return { doc: undefined, source }
}

const { createRequire } = await import('node:module')
const { doc, source } = loadWorkflow()
if (doc === undefined) {
  console.error('✗ 找不到可用的 YAML 解析器（先在内核里 pnpm install）')
  process.exit(1)
}

// 1) release job 必须依赖打包 job
const jobs = doc.jobs ?? {}
const release = jobs.release
if (release === undefined) fail(`${path}: 没有 release job（CD 未接上）`)
else {
  const needs = Array.isArray(release.needs) ? release.needs : [release.needs]
  if (!needs.includes('desktop')) fail(`${path}: release 必须 needs: desktop，否则打包失败也会发 Release`)
  else ok('release job 依赖打包 job（验收全绿后才发布）')
}

// 2) 权限分层
if (doc.permissions?.contents !== 'read') fail(`${path}: 顶层 permissions.contents 应为 read（最小权限）`)
else if (release?.permissions?.contents !== 'write') fail(`${path}: release job 需要 permissions.contents: write`)
else ok('权限分层：顶层 read、release job write')

// 3) 发布命令用 --notes-file
const releaseSteps = release?.steps ?? []
const publish = releaseSteps.find((step) => typeof step.run === 'string' && step.run.includes('gh release create'))
if (publish === undefined) fail(`${path}: 找不到 gh release create 步骤`)
else {
  if (!publish.run.includes('--notes-file')) fail('发布命令必须用 --notes-file（避免 shell 解析 markdown）')
  else ok('发布命令用 --notes-file')
}

// 4) 汇总脚本必须摊平嵌套路径 + 空制品失败
const collect = releaseSteps.find((step) => typeof step.run === 'string' && step.run.includes('SHA256SUMS'))
if (collect === undefined) fail(`${path}: 找不到生成 SHA256SUMS 的步骤`)
else {
  if (!collect.run.includes('find download')) fail('必须用 find 摊平 download-artifact 的嵌套路径（dist/*.exe 匹配不到）')
  else ok('汇总脚本用 find 摊平嵌套路径')
  if (!/test -n/.test(collect.run)) fail('必须对「一个制品都没有」显式失败，否则会发布空 Release')
  else ok('空制品时显式失败')
}

// 5) run 里不得出现裸反引号（注释行除外：说明文字里引用命令是正常的）
//
// ⚠️ 只查非注释行。第一版把注释里的 `sha256sum *.dmg` 也算成违规 —— 门禁过严会误报，
// 而误报的门禁最后会被绕过，比没有更糟。
for (const [index, step] of releaseSteps.entries()) {
  if (typeof step.run !== 'string') continue
  const offending = step.run
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .filter((line) => line.includes('`'))
  if (offending.length > 0) {
    fail(`release 第 ${String(index + 1)} 步的 run 含反引号（bash 会当命令替换执行）：${offending[0].trim().slice(0, 80)}`)
  }
}
if (!failed) ok('run 的可执行行里无裸反引号')

if (failed) {
  console.error('发布工作流结构校验失败')
  process.exit(1)
}
void source
console.log('✓ 发布工作流结构正确（CD 会在验收全绿后自动发 Release）')
