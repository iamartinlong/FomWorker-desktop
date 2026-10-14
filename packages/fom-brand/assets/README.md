# fom-brand · 资产（assets）

FomWorker 品牌**矢量源**（由 `fom-logo.png` 派生）。供**打包/图标/安装器/欢迎窗**使用。

| 文件 | 用途 | 说明 |
|---|---|---|
| `mark.svg` | 品牌标记（侧栏/hero 同款几何） | 64×64；蓝 C/立方 `#038AC6` + 琥珀箭头/竖条 `#FCB513` |
| `icon.svg` | 应用图标（1024×1024，圆角底 + 居中标记） | electron-builder 生成 ICO；macOS 导出 ICNS |

> ⚠️ **近似版**（按 PNG 手绘）；拿到 logo **矢量源文件**后应替换为精确路径。

## 派生（打包用二进制）

内核 `apps/desktop` 期望的资产（**构建期覆盖**，不改内核源码）：

| 内核文件 | 我们的来源 | 生成 |
|---|---|---|
| `resources/icon.svg` / `icon.png`（1024×1024 透明） | `assets/icon.svg` | SVG → 1024 PNG |
| `resources/icon-windows.{png,svg}`、`icon-macos.{png,svg}` | 同 | 平台适配（可同图） |
| Windows ICO（app/installer/uninstaller） | electron-builder 自动 | 由 `icon.png` 生成 |
| `resources/tray-windows.ico` | 由 `icon-windows.svg` 渲染 | `pnpm run render:tray-icon`（16/20/24/32/40/48/64） |
| `installer/assets/brand*.png`（安装器标题图） | `assets/icon.svg` | 派生（明/暗两版） |
| `installer/assets/uninstaller-sidebar.png` | 派生 | 转 **164×314 BMP** |
| `renderer/assets/welcome-brand.svg`（欢迎窗） | `assets/mark.svg` | 直接复用 |

**工具**：SVG→PNG 用 `sharp`/`resvg`/ImageMagick；ICO/ICNS 由 electron-builder 或 `png2icons`/`iconutil`。具体命令见内核 `apps/desktop/README.md`（图标/托盘段）。

**阶段2**：fork `apps/desktop` 后，这些资产成为**我们的源码**，无需构建期覆盖。
