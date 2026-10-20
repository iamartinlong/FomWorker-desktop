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

// 1. 产品名：把内核里硬编码的 `DeepSeek Harness` 全换成 FomWorker——产品名 / 协议名 / 麦克风说明 /
//    **exe 与 .app 路径**（smoke 与 pack 脚本按 productName 拼路径，不改就会找不到可执行文件）/
//    菜单与 locale 文案 / `applicationName`。
const BRANDED_FILES = [
  'scripts/electron-builder-config.mjs',
  'scripts/smoke-packaged-runtime.ts',
  'scripts/package-target.ts',
  'scripts/package-macos.ts',
  'scripts/development-app.ts',
  'src/main.ts',
  'src/locale.ts',
]
for (const rel of BRANDED_FILES) {
  const file = join(desktopRoot, rel)
  const before = await readFile(file, 'utf8')
  const after = before.replaceAll('DeepSeek Harness', PRODUCT_NAME)
  if (after !== before) await writeFile(file, after)
}

// 1b. 安装包文件名前缀。
const configPath = join(desktopRoot, 'scripts', 'electron-builder-config.mjs')
const config = await readFile(configPath, 'utf8')
await writeFile(configPath, config.replace(/artifactName: `deepseek-harness-/, `artifactName: \`${ARTIFACT_PREFIX}-`))

// 2. 图标：应用图标（png）+ 托盘图标（ico）；SVG 同时替换三份矢量源。
for (const file of ['icon.svg', 'icon-windows.svg', 'icon-macos.svg']) await writeFile(join(resources, file), svg)
await sharp(svg).resize(1024, 1024).png().toFile(join(resources, 'icon.png'))
await sharp(svg).resize(1024, 1024).png().toFile(join(resources, 'icon-macos.png'))
await sharp(svg).resize(256, 256).png().toFile(join(resources, 'icon-windows.png'))
const tray = await Promise.all(TRAY_SIZES.map(async size => ({ size, png: await sharp(svg).resize(size, size).png().toBuffer() })))
await writeFile(join(resources, 'tray-windows.ico'), packIco(tray))

console.log(`branding: applied ${PRODUCT_NAME} to ${desktopRoot}`)
