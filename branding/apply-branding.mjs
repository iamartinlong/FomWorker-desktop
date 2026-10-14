/**
 * 桌面端 FomWorker 品牌覆盖层：在克隆好的内核树上改产品名 + 生成品牌图标。
 *
 * 用法（桌面仓根目录）：
 *   node branding/apply-branding.mjs [内核目录=deepseek-harness]
 * 前置：内核已 `pnpm install`（脚本借 apps/desktop 的 sharp 栅格化 SVG）。
 */
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const PRODUCT_NAME = 'FomWorker'
const ARTIFACT_PREFIX = 'fomworker'
const TRAY_SIZES = [16, 20, 24, 32, 40, 48, 64]

const kernelRoot = resolve(process.argv[2] ?? 'deepseek-harness')
const desktopRoot = join(kernelRoot, 'apps', 'desktop')
const resources = join(desktopRoot, 'resources')
const brandingRoot = import.meta.dirname

const sharp = createRequire(join(desktopRoot, 'package.json'))('sharp')

/** 把若干 PNG 位图打包成一个 ICO（Windows Vista+ 直接读 PNG 压缩项）。 */
function packIco(entries) {
  const header = Buffer.alloc(6 + 16 * entries.length)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  let offset = header.length
  entries.forEach((entry, index) => {
    const at = 6 + 16 * index
    header.writeUInt8(entry.size % 256, at)
    header.writeUInt8(entry.size % 256, at + 1)
    header.writeUInt8(0, at + 2)
    header.writeUInt8(0, at + 3)
    header.writeUInt16LE(1, at + 4)
    header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(entry.png.length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += entry.png.length
  })
  return Buffer.concat([header, ...entries.map(entry => entry.png)])
}

const svg = await readFile(join(brandingRoot, 'icon.svg'))

// 1. electron-builder：产品名 / 协议名 / 安装包名前缀。
const configPath = join(desktopRoot, 'scripts', 'electron-builder-config.mjs')
let config = await readFile(configPath, 'utf8')
config = config.replaceAll("productName: 'DeepSeek Harness'", `productName: '${PRODUCT_NAME}'`)
config = config.replaceAll("name: 'DeepSeek Harness', schemes: ['dsh']", `name: '${PRODUCT_NAME}', schemes: ['dsh']`)
config = config.replace(/artifactName: `deepseek-harness-/, `artifactName: \`${ARTIFACT_PREFIX}-`)
await writeFile(configPath, config)

// 2. 图标：应用图标（png）+ 托盘图标（ico）；SVG 同时替换三份矢量源。
for (const file of ['icon.svg', 'icon-windows.svg', 'icon-macos.svg']) await writeFile(join(resources, file), svg)
await sharp(svg).resize(1024, 1024).png().toFile(join(resources, 'icon.png'))
await sharp(svg).resize(1024, 1024).png().toFile(join(resources, 'icon-macos.png'))
await sharp(svg).resize(256, 256).png().toFile(join(resources, 'icon-windows.png'))
const tray = await Promise.all(TRAY_SIZES.map(async size => ({ size, png: await sharp(svg).resize(size, size).png().toBuffer() })))
await writeFile(join(resources, 'tray-windows.ico'), packIco(tray))

console.log(`branding: applied ${PRODUCT_NAME} to ${desktopRoot}`)
