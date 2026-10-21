/**
 * 内核 host 门禁的类型检查（**必须跑这一个，不是 `apps/desktop/tsconfig.host.json`**）。
 *
 * ## 为什么需要它（2026-10-21 `pkg-14` 实测踩到）
 *
 * 内核有两层 host 配置：
 *   - `apps/desktop/tsconfig.host.json` —— `include: ["src"]`，**不含测试**；
 *   - 根 `tsconfig.host.json` —— `include: ["apps/desktop/tests/**\/*.ts", …]`，
 *     这才是 `build:official` 的 `run-gates` 里那个 `host aggregate check` 跑的东西。
 *
 * 只跑前者时，**测试目录的类型错误完全看不见**。`pkg-14` 就是这样：本地 `tsc` 报 0 错、
 * CI 却在 `host aggregate check` 挂住——`welcome-flow.e2e.ts` 仍在调已删的 `backend.save()`。
 *
 * ## 还有第二层坑：陈旧的 `lib/types`
 *
 * 改了 `src/*.ts` 后，根 `tsconfig.host.json` 解析 workspace 引用时会拿**旧的** `lib/types`，
 * 于是报「Property 'save' does not exist」这类**假错误**（源码里明明有）。所以先
 * `tsc -b apps/desktop/tsconfig.host.json --force` 重建，再做 `-p` 全量检查。
 *
 * 用法（产品仓根）：node scripts/check-kernel-host.mjs [内核目录=deepseek-harness]
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const kernelRoot = resolve(process.argv[2] ?? 'deepseek-harness')
const tsc = join(kernelRoot, 'node_modules', 'typescript', 'bin', 'tsc')

if (!existsSync(tsc)) {
  console.error(`✗ 找不到 tsc：${tsc}（先在内核里 pnpm install）`)
  process.exit(1)
}

/** 跑一步 tsc，失败时把输出原样透出并退出。 */
function run(label, args) {
  process.stdout.write(`— ${label}\n`)
  try {
    execFileSync(process.execPath, [tsc, ...args], { cwd: kernelRoot, stdio: 'inherit' })
  } catch {
    console.error(`✗ ${label} 失败（上方是 tsc 输出）`)
    process.exit(1)
  }
}

// 1. 先把 desktop 的 host 半重建出来：根配置解析 workspace 引用时要有新鲜的 lib/types，
//    否则会拿旧声明报「属性不存在」的假错误。
run('重建 apps/desktop 的 host 半（tsc -b --force）', ['-b', 'apps/desktop/tsconfig.host.json', '--force'])
// 2. 再跑根配置：这一步才覆盖 apps/desktop/tests，等价于 CI 的 host aggregate check。
run('内核 host 门禁（根 tsconfig.host.json，含测试）', ['-p', 'tsconfig.host.json', '--noEmit'])

console.log('✓ 内核 host 门禁通过（含 apps/desktop/tests 的类型检查）')
