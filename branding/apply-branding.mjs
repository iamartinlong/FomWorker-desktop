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
  // 期望文件也带产品名：品牌改名后 `main-startup` 的 About 断言必须跟着变，
  // 否则品牌补丁一打，内核自带的那组测试立刻红（2026-10-21 实测）。
  'tests/expected/about-panel.json',
  'tests/expected/application-menu-en-US.json',
  'tests/expected/application-menu-zh-CN.json',
  // 该测试另有两处内联断言写死了产品名（About 标题与退出确认菜单），
  // 与上面的期望文件同源，一并品牌化。
  'tests/main-startup.spec.ts',
  // 其余断言产品名的内核测试：品牌改名后它们必须同步，否则每打一次品牌补丁
  // 就多出一组红（2026-10-21 实测 6 例）。
  'tests/tray.spec.ts',
  'tests/quit-confirmation.spec.ts',
  'tests/background-notice.spec.ts',
  'tests/fatal-recovery.spec.ts',
  'tests/expected/fatal-address-in-use-en.txt',
  'tests/expected/fatal-address-in-use-zh-CN.txt',
  'tests/expected/fatal-dialog-en.txt',
  'tests/expected/fatal-dialog-zh-CN.txt',
  'tests/expected/fatal-dialog-with-report-en.txt',
  'tests/expected/fatal-dialog-with-report-zh-CN.txt',
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

// 2b. 欢迎页的品牌标记（`renderer/assets/welcome-brand.svg`）。
//
// 为什么需要（2026-10-21 实装发现）：欢迎页显示的仍是官方 `deepseek HARNESS` logo。
// 那张 SVG 的字形是**矢量路径**（17 个 path，没有 `<text>`），不能像产品名那样 replaceAll，
// 所以 `BRANDED_FILES` 永远覆盖不到它 —— 与安装器品牌图同一类问题（图 vs 文本）。
//
// 这里把它换成**纯品牌标记**（40×40 方标）。旁边的产品名由 `WelcomePage` 用 HTML 渲染：
//   · 原图把字形画成路径 ⇒ 换品牌要重画字形，不可维护；
//   · 若改用 SVG `<text>`，打包期用 libvips 栅格化时缺字体会渲染成空白（本地实测）。
// 拆开后图只负责 logo（矢量、可靠），文字交给 Chromium 用系统字体 + CSS 变量切深浅色。
const welcomeMark = `<svg width="40" height="40" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M20 20 L36 8 L56 19 L56 33 L38 22 L30 27 L30 52 L16 44 L16 22 Z" fill="#038AC6"/>
<path d="M30 16 L40 10 L50 16 L46 19 L40 15.5 L34 19 Z" fill="#FCB513"/>
<path d="M42 22 L55 30 L55 50 L48.5 54 L42 50 Z" fill="#FCB513"/>
</svg>
`
await writeFile(join(desktopRoot, 'renderer', 'assets', 'welcome-brand.svg'), welcomeMark)

// 3. 安装器（NSIS）的品牌图。
//
// 为什么需要（2026-10-20 实装发现）：装 `pkg-11`/`pkg-17` 时，**NSIS 向导首页显示的是官方
// `deepseek HARNESS` logo**。原因是 `installer/assets/brand{,-2x,-dark,-dark-2x}.png` 这几张
// 位图**不在 BRANDED_FILES 里**——它是图，不是能 replaceAll 的文本，所以一直被漏掉。
//
// 链路（读代码确认，不是推测）：
//   installer/assets/brand*.png
//     → scripts/prepare-windows-installer.ps1（转成 24bpp BMP）
//       → installer-ui/brand*.bmp
//         → NSIS 用 $PLUGINSDIR\brand-2x.bmp（lifecycle.nsh:60）
//
// ⚠️ 底色要留**透明**：官方原图的左上角像素是 `A=0`，而 prepare 脚本会用
// `RGB(21,21,23)`（深色）/ 白色（浅色）重填底 —— 见该脚本第 72-73 行。我们若自己填底色，
// 会和它填的那层出现色差缝。
const assets = join(desktopRoot, 'installer', 'assets')

/**
 * 合成一张安装器品牌图。
 * @param scale - 1 或 2（2 表示 1200×392 的高分屏版）。
 * @param dark - 深色主题（只影响文字颜色；底色留透明，由 prepare 脚本填）。
 * @returns PNG 字节。
 */
async function installerBrand(scale, dark) {
  const width = 600 * scale
  const height = 196 * scale
  const markSize = Math.round(96 * scale)
  const ink = dark ? '#FFFFFF' : '#0F1115'
  const fontSize = Math.round(30 * scale)
  const markTop = Math.round(28 * scale)

  // 图标：复用同一份品牌 SVG（方形），居中放在上方。
  const mark = await sharp(svg).resize(markSize, markSize).png().toBuffer()

  // 文字：用 SVG 画，再叠加。字体族取系统无衬线，避免依赖字体文件。
  const label = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`
    + `<text x="${width / 2}" y="${Math.round(160 * scale)}" text-anchor="middle" `
    + `font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="${fontSize}" `
    + `font-weight="700" letter-spacing="0.5" fill="${ink}">${PRODUCT_NAME}</text>`
    + '</svg>',
  )

  // 透明底（alpha 0），与官方原图一致。
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: mark, left: Math.round((width - markSize) / 2), top: markTop },
      { input: label, left: 0, top: 0 },
    ])
    .png()
    .toBuffer()
}

for (const [name, scale, dark] of [
  ['brand.png', 1, false],
  ['brand-2x.png', 2, false],
  ['brand-dark.png', 1, true],
  ['brand-dark-2x.png', 2, true],
]) {
  await writeFile(join(assets, name), await installerBrand(scale, dark))
}

// 卸载器侧边栏（164×314）：官方同尺寸，透明底 + 居中 logo。
const sidebarMark = await sharp(svg).resize(96, 96).png().toBuffer()
await writeFile(join(assets, 'uninstaller-sidebar.png'), await sharp({
  create: { width: 164, height: 314, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
  .composite([{ input: sidebarMark, left: 34, top: 109 }])
  .png()
  .toBuffer())

console.log(`branding: applied ${PRODUCT_NAME} to ${desktopRoot}`)
