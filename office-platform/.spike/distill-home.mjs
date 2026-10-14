/**
 * 记忆层 §7 第 6 步 · F-6A 的修法：给**蒸馏进程**一个独立 `DSH_HOME`，让两个活着的 dsh 实例不再
 * 共用同一份 `storages/schedule.json`（否则任一方写任务都会整份重写、把对方刚武装的 nightly 行抹掉/堆叠）。
 *
 * 做法＝「共享引用 + 独立 storages」：把 `~/.dsh` 的各种入口以**引用**方式摆进新 home，唯独 `storages/`
 * 是一个真目录 ⇒ 蒸馏的 `schedule.json` 与 `office_memory_run` 落在自己那儿，member 的审批薄记仍落在
 * `~/.dsh`。这样凭据、profile、会话历史等一切共享件都还在，蒸馏进程照旧能读凭据、加载 web profile。
 *
 * ⚠️ **不读凭据内容**：文件用**硬链接**（`fs.linkSync`，不需管理员，也不复制字节）；目录用 **junction**
 * （`fs.symlinkSync(dir, link, 'junction')`，同样不需管理员）。文件符号链接在这台机器上要管理员，故不用。
 * 硬链接的代价：若内核把 `.credentials.yaml` 以「临时文件 + rename」方式重写，链接会断、新 home 里成为一份
 * 过期副本 —— 对一次观测无害（凭据只读），但要如实记下这条边界。
 *
 * 用法（被 `run-step6.mjs` 起进程前调用）：
 *   import { ensureDistillHome } from './distill-home.mjs'
 *   ensureDistillHome('F:/.../.spike/distill-home', 'C:/Users/EDY/.dsh')
 */
import fs from 'node:fs'
import path from 'node:path'

/** `~/.dsh` 里**必须独立**的那一个入口名；其余全部引用过来。 */
const ISOLATED = 'storages'

/**
 * （重）建蒸馏进程的独立 home：除 `storages` 外，把源 home 的每个顶层入口以 junction（目录）或
 * hardlink（文件）摆进来，并建一个空的 `storages/`。
 * @param home - 目标 home（会被整目录重建）。**必须与 `source` 同卷**（都在 C:）—— 文件走 `fs.linkSync` 硬链接，硬链接不能跨卷（EXDEV）。
 * @param source - 源 home（默认 `C:/Users/EDY/.dsh`）。
 * @returns 实际建立的引用清单（给调用方打印）。
 */
export function ensureDistillHome(home, source = 'C:/Users/EDY/.dsh') {
  fs.rmSync(home, { recursive: true, force: true })
  fs.mkdirSync(home, { recursive: true })
  const linked = []
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === ISOLATED) continue
    const from = path.join(source, entry.name)
    const to = path.join(home, entry.name)
    if (entry.isDirectory()) {
      fs.symlinkSync(from, to, 'junction')
      linked.push(`dir  ${entry.name}`)
    } else {
      fs.linkSync(from, to)
      linked.push(`file ${entry.name}`)
    }
  }
  fs.mkdirSync(path.join(home, ISOLATED), { recursive: true })
  linked.push(`dir  ${ISOLATED}（独立、空）`)
  return linked
}

if (process.argv[1] !== undefined && path.basename(process.argv[1]) === 'distill-home.mjs') {
  const home = process.argv[2] ?? 'C:/Users/EDY/.dsh-distill'
  const linked = ensureDistillHome(home)
  console.log(`built ${home}`)
  for (const line of linked) console.log(`  ${line}`)
}
