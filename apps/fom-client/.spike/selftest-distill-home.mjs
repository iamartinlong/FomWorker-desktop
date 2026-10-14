/**
 * `.spike/distill-home.mjs`（F-6A 的独立 DSH_HOME 构建件）的自证。
 *
 * 为什么单独一档：这个构建件不进 `vitest`/`tsc` 任何一道门禁（`.spike/**` 都不进），而它的正确性直接
 * 决定那一夜两进程会不会又共写一份 `schedule.json` —— 一旦它把 `storages` 也 junction 过去，F-6A 的修复
 * 会**静默退回**（两边又共写、nightly 又被抹），而观测当天看不出任何异常。所以用**合成源目录**把它的每条
 * 口径钉住：目录→junction、文件→hardlink、`storages` 必须**独立且空**、重复调用幂等、跨卷要响亮抛。
 *
 * 跑法：`node .spike/selftest-distill-home.mjs`（纯临时目录，不碰真 `~/.dsh`、不起进程）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureDistillHome } from './distill-home.mjs'

const failures = []
const pass = (label) => console.log(`✓ ${label}`)
const expect = (cond, label) => { if (cond) pass(label); else failures.push(label) }

function makeSource() {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'distill-home-src-'))
  fs.mkdirSync(path.join(src, 'profiles'), { recursive: true })
  fs.writeFileSync(path.join(src, 'profiles', 'web.yml'), 'x', 'utf8')
  fs.mkdirSync(path.join(src, 'storages'), { recursive: true })
  fs.writeFileSync(path.join(src, 'storages', 'schedule.json'), '{"real":true}', 'utf8')
  fs.writeFileSync(path.join(src, '.credentials.yaml'), 'secret-ref', 'utf8')
  return src
}

// ① 目录→junction、文件→hardlink、storages 独立且空。
{
  const src = makeSource()
  const home = path.join(os.tmpdir(), `distill-home-out-${String(Date.now())}`)
  const linked = ensureDistillHome(home, src)

  const profiles = path.join(home, 'profiles')
  expect(fs.lstatSync(profiles).isSymbolicLink(), '目录以 junction 引用（lstat isSymbolicLink）')
  expect(fs.readFileSync(path.join(profiles, 'web.yml'), 'utf8') === 'x', 'junction 下的文件可读')
  expect(fs.realpathSync(profiles) === fs.realpathSync(path.join(src, 'profiles')), 'junction 指向真实源目录')

  const cred = path.join(home, '.credentials.yaml')
  expect(fs.statSync(cred).nlink >= 2, '文件以 hardlink 引用（nlink≥2）')
  expect(fs.readFileSync(cred, 'utf8') === 'secret-ref', 'hardlink 内容一致')
  expect(!fs.lstatSync(cred).isSymbolicLink(), '文件不是 symlink（这台机器上 symlink 要管理员）')

  const storages = path.join(home, 'storages')
  expect(fs.lstatSync(storages).isDirectory() && !fs.lstatSync(storages).isSymbolicLink(), 'storages 是真目录，不是 junction')
  expect(fs.readdirSync(storages).length === 0, 'storages 独立且为空（源里那份 schedule.json 没被带进来）')
  expect(!fs.existsSync(path.join(storages, 'schedule.json')), '源的 storages/schedule.json 未出现在新 home')

  expect(linked.some(line => line.includes('storages')), '返回值里点名了 storage 的独立')
  fs.rmSync(src, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
}

// ② 重复调用幂等（先删旧 home 再重建；旧链接不能残留）。
{
  const src = makeSource()
  const home = path.join(os.tmpdir(), `distill-home-idem-${String(Date.now())}`)
  ensureDistillHome(home, src)
  fs.writeFileSync(path.join(home, 'storages', 'leftover.json'), 'old', 'utf8') // 上一轮的残留
  ensureDistillHome(home, src) // 重建应把它清掉
  expect(!fs.existsSync(path.join(home, 'storages', 'leftover.json')), '重复调用重建：上一轮 storages 残留被清掉')
  expect(fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8') === 'secret-ref', '重复调用后链接仍正确')
  fs.rmSync(src, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
}

// ③ 跨卷硬链接必须响亮抛（F:→C: 实测 EXDEV —— 若悄悄吞掉，观测会拿一个没有凭据的 home 起进程）。
{
  const src = makeSource()
  const xvol = 'F:/deepseek/deepseek harness/apps/fom-client/.spike/distill-home-selftest-xvol'
  let threw = ''
  try { ensureDistillHome(xvol, src) }
  catch (error) { threw = String(error) }
  expect(threw !== '', '跨卷（C:→F:）建硬链接抛错而不是静默')
  expect(/EXDEV|link|跨|cross/i.test(threw), '抛的是链接/跨卷类错误（不是别的意外）')
  fs.rmSync(src, { recursive: true, force: true })
  fs.rmSync(xvol, { recursive: true, force: true })
}

if (failures.length === 0) {
  console.log('PASS（合成源 + 临时 home，真链接语义，未碰 ~/.dsh、未起进程）')
} else {
  for (const label of failures) console.log(`✗ ${label}`)
  console.log(`FAIL：${String(failures.length)} 项`)
  process.exit(1)
}
