/**
 * 安装器（NSIS）品牌图的品牌化校验。
 *
 * ## 为什么需要它（2026-10-20/21 两次实装都看到官方 logo）
 *
 * `installer/assets/brand{,-2x,-dark,-dark-2x}.png` 与 `uninstaller-sidebar.png` 是**图片**，
 * 不是能 `replaceAll` 的文本 ⇒ `apply-branding.mjs` 的 `BRANDED_FILES`（文本清单）永远覆盖不到，
 * 于是装的时候**第一眼看到的是 `deepseek HARNESS` logo**。
 *
 * ## 为什么必须在**打包前**校验源码树，而不是校验产物
 *
 * 这几张 PNG 会被 `prepare-windows-installer.ps1` 转成 24bpp BMP，然后**编进 NSIS 安装器本体**，
 * 不在 electron-builder 的 7z 载荷里 ⇒ `verify-installer.mjs`（解 7z 取 app.asar）读不到它们。
 * 唯一能自动检查的时机就是打包前、`apply-branding` 跑完之后。
 *
 * ## 判据
 *
 * 1. 五张图都存在，且**尺寸**与内核约定一致（600×196 / 1200×392 / 164×314）；
 * 2. 底色必须是**透明**（alpha 0）——`prepare-windows-installer.ps1` 会用自己的
 *    `RGB(21,21,23)`（深色）/ 白色（浅色）重填；图自己带底色会与那层叠出缝；
 * 3. 图片**不得与内核原版逐字节相同**——这是「真的换过了」的直接证据。原版内容由
 *    `installer/assets` 的官方图确定，但我们不能假设它不变，所以用「品牌化前后哈希不同」
 *    之外更稳的判据：**检查图里出现产品名的文字像素**做不到（图是位图）。
 *    ⇒ 改用「尺寸 + alpha 0 + 与官方图基线哈希不同」。官方基线哈希不硬编码，
 *    而是要求：**图片中存在非白、非透明的彩色像素**（官方 logo 是深灰单色，我们是蓝+琥珀）。
 *
 * 用法（产品仓根）：node scripts/check-installer-brand.mjs [内核目录=deepseek-harness]
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const kernelRoot = resolve(process.argv[2] ?? 'deepseek-harness')
const assets = join(kernelRoot, 'apps', 'desktop', 'installer', 'assets')

let failed = false
const ok = (message) => { console.log('✓ ' + message) }
const fail = (message) => { console.error('✗ ' + message); failed = true }

/** 期望尺寸（与内核 `theme.nsh` / electron-builder 的 nsis 段一致）。 */
const EXPECTED = [
  ['brand.png', 600, 196],
  ['brand-2x.png', 1200, 392],
  ['brand-dark.png', 600, 196],
  ['brand-dark-2x.png', 1200, 392],
  ['uninstaller-sidebar.png', 164, 314],
]

/** 从 PNG 头部读尺寸（IHDR 紧跟 8 字节签名 + 4 字节长度 + 4 字节类型）。 */
function pngSize(buffer) {
  if (buffer.length < 24) return undefined
  const signature = buffer.subarray(0, 8).toString('hex')
  if (signature !== '89504e470d0a1a0a') return undefined
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

if (!existsSync(assets)) {
  fail(`${assets} 不存在（内核树没准备好？）`)
  process.exit(1)
}

for (const [name, width, height] of EXPECTED) {
  const file = join(assets, name)
  if (!existsSync(file)) {
    fail(`${name} 缺失`)
    continue
  }
  const buffer = readFileSync(file)
  const size = pngSize(buffer)
  if (size === undefined) {
    fail(`${name} 不是有效 PNG`)
    continue
  }
  if (size.width !== width || size.height !== height) {
    fail(`${name} 尺寸 ${String(size.width)}×${String(size.height)}，应为 ${String(width)}×${String(height)}`)
    continue
  }
  // 官方图只有深灰/白；我们的品牌图带蓝与琥珀。用「文件明显不同」做粗判：
  // 官方原图 < 20 KB，我们生成的是矢量栅格化，体积落在同一量级 ⇒ 不用体积，改用
  // 「调色板里存在高饱和蓝」这一条真的能区分（官方是纯灰度）。
  ok(`${name} ${String(width)}×${String(height)} 在位`)
}

// 关键区分：品牌图必须有**彩色**像素（蓝/琥珀），官方是灰度。
// 直接解 PNG 太复杂，用 sharp（内核里已有，apply-branding 也在用）。
try {
  const { createRequire } = await import('node:module')
  const sharp = createRequire(join(kernelRoot, 'apps', 'desktop', 'package.json'))('sharp')
  for (const [name] of EXPECTED.slice(0, 4)) {
    const file = join(assets, name)
    if (!existsSync(file)) continue
    const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true })
    let colourful = 0
    for (let i = 0; i < data.length; i += info.channels) {
      const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], info.channels > 3 ? data[i + 3] : 255]
      if (a < 16) continue
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      if (max - min > 40) colourful += 1
    }
    if (colourful === 0) fail(`${name} 没有任何彩色像素——像是还没换掉的官方灰度图`)
    else ok(`${name} 含 ${String(colourful)} 个彩色像素（已替换为 FomWorker 蓝/琥珀）`)
  }
} catch (error) {
  fail(`无法读取像素（sharp 不可用）：${String(error?.message ?? error)}`)
}

// 透明度：prepare-windows-installer.ps1 会重填底色，图自己带底会叠出缝。
try {
  const { createRequire } = await import('node:module')
  const sharp = createRequire(join(kernelRoot, 'apps', 'desktop', 'package.json'))('sharp')
  for (const [name] of EXPECTED) {
    const file = join(assets, name)
    if (!existsSync(file)) continue
    const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true })
    if (info.channels < 4) {
      fail(`${name} 没有 alpha 通道——底色会被 prepare 脚本再填一层，出现色差缝`)
      continue
    }
    // 四角都应为透明（品牌内容居中）。
    const corner = (x, y) => data[(y * info.width + x) * info.channels + 3]
    const corners = [corner(0, 0), corner(info.width - 1, 0), corner(0, info.height - 1), corner(info.width - 1, info.height - 1)]
    if (corners.some((alpha) => alpha !== 0)) fail(`${name} 四角应透明（实测 ${corners.join('/')}）`)
    else ok(`${name} 四角透明（底色交给 prepare 脚本）`)
  }
} catch { /* 上一段已报错 */ }

if (failed) {
  console.error('安装器品牌图校验失败：装的时候会看到官方 logo')
  process.exit(1)
}
console.log('✓ 安装器品牌图已品牌化（NSIS 向导不会再显示官方 logo）')
