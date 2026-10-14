// 只起进程（detached）后立即退出，避免长命令被工具中断；随后分开轮询/探测。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const KERNEL = String.raw`F:\deepseek\deepseek harness\deepseek-harness`
const PLATFORM = String.raw`F:\deepseek\deepseek harness\office-platform`
const SPIKE = String.raw`F:\deepseek\deepseek harness\office-platform\.spike`
const PORT = Number(process.argv[2] ?? 3206)
const LOG = path.join(SPIKE, 'console-boot.log')

const out = fs.openSync(LOG, 'w')
const child = spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web',
  '--patch', path.join(PLATFORM, 'office-catalog.patch.yml'),
  '--patch', path.join(PLATFORM, 'office-console.patch.yml'),
  '--no-open', '--port', String(PORT)], { cwd: KERNEL, stdio: ['ignore', out, out], detached: true })
child.unref()
fs.writeFileSync(path.join(SPIKE, 'console.pid'), `${String(child.pid)}\n`, 'utf8')
console.log(`spawned pid=${String(child.pid)} port=${String(PORT)}`)
