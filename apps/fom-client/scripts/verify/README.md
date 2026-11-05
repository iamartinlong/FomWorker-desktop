# `scripts/verify/` —— 客户端线的发布前/发布后校验工具

这三个脚本把 2026-11-05 那几轮发版里**踩出来才有的手段**固化成可复用工具。
在那之前，这些方法只存在于临时目录（会被 Windows 清掉）和对话里。

| 脚本 | 什么时候用 |
|---|---|
| `replay-host-halves.mjs` | **改了任何插件 host 源码（`index.ts` 及其相对依赖）之后**——确认 committed `lib/index.js` 是真构建产物 |
| `verify-skill-descriptions.mjs` | 改了 `office-skills` 的 `SKILLS` 数组或任何 `assets/*/SKILL.md` 之后 |
| `poll-release.mjs` | 推了 tag 之后等 CI |

---

## 1. 前置：esbuild 原生二进制（一次性）

仓库里只有 esbuild 的 **JS 主包**（`apps/fom-client/node_modules/esbuild`），
缺平台包（`@esbuild/win32-x64`）时两个构建脚本都跑不起来。
**平台包不入库**（二进制、版本随主包走），用的时候临时装：

```powershell
# 版本必须与主包一致：见 apps/fom-client/node_modules/esbuild/package.json
$v = (Get-Content apps/fom-client/node_modules/esbuild/package.json -Raw | ConvertFrom-Json).version
$tmp = Join-Path $env:TEMP "fom-esbuild"; New-Item -ItemType Directory -Path $tmp -Force | Out-Null
Push-Location $tmp
npm pack "@esbuild/win32-x64@$v" --silent
tar -xzf (Get-ChildItem "$tmp\*.tgz" | Select-Object -First 1).Name
$env:ESBUILD_BINARY_PATH = Join-Path $tmp "package\esbuild.exe"
Pop-Location
```

`ESBUILD_BINARY_PATH` 只对**当前 shell** 有效；esbuild 自己的默认解析（`node_modules/@esbuild/*`）也认。

### 版本钉在 `../esbuild-version.json`

```powershell
node -p "require('./apps/fom-client/scripts/esbuild-version.json').esbuild"   # 现值 0.25.12
```

**这份文件是「committed 产物用哪个 esbuild 产出」的声明**，本地和 CI 都读它。
本地用别的版本重建并提交产物后，**必须有意识地改它**——否则 CI 装旧版本重放会字节对不上、假红。

> ⚠️ **别为了跑构建去 `pnpm install`**：产品根不装依赖（AGENTS.md §6），
> 上面这套就是为「不碰仓库依赖」设计的。

## 1b. CI 已接上门禁（2026-11-05）

`.github/workflows/package.yml` 里「校验产物新鲜度」那一步会自动跑本目录的
`replay-host-halves.mjs`：按 `esbuild-version.json` 装一份 esbuild（桌面仓自己没有依赖）、
重放 12 个插件、逐个与 committed 产物比。**改了 `index.ts` 忘了重建 ⇒ CI 直接红。**
⇒ 本地提交前跑一遍同一个脚本，等于预演 CI。

## 2. `replay-host-halves.mjs` —— 产物新鲜度探测器

```powershell
node apps/fom-client/scripts/verify/replay-host-halves.mjs              # 只比对
node apps/fom-client/scripts/verify/replay-host-halves.mjs office-skills # 只查一个
node apps/fom-client/scripts/verify/replay-host-halves.mjs --write       # 不一致就覆盖
```

按 `build-host-halves.mjs` **同一套选项**（absWorkingDir=仓库根、bundle/esm/node/es2024/
packages external/sourcemap false）重放全部 12 个 HOST_ONLY 插件，逐个与 committed 产物逐字节比。

**为什么必须全量比、不能只比改的那个**：只比一个，无法区分「我的重放环境错了」和
「那份产物是假的」。**多数一致 + 一个不一致**才能同时证明两件事——
重放环境忠实，且那个不一致的确实是手改件。（踩坑 §2.30：2026-11-05 实测 11/12 一致，
唯一不一致的 `office-skills` 正是前一天手改后提交的那份，diff 里全是手写注释、
import 被拆成两条、缺 esbuild 的 `/* @__PURE__ */`。）

**判为「手改件」的三个信号**：手写注释（esbuild 只留法律注释）、同源 import 被拆成多条、
缺 `/* @__PURE__ */` 或 esbuild 的重命名后缀（`foo2`/`foo3`）、导出顺序非字典序。

### ⚠️ 比较前必须按 LF 归一化（`pkg-34` 首跑 12/12 全红换来的）

CI 的 `actions/checkout` 在 Windows 上按 Git for Windows 默认 `core.autocrlf=true`，
把仓库里 **LF** 的文件落成 **CRLF** ⇒ `lib/index.js` 在 CI 工作树里每行多一个 CR。
**本地仓库是 LF，所以本地全绿、CI 全红**，且差值精确等于行数。

⇒ 脚本的做法：原样不同时**再按 LF 归一化比一次**，并分行报告——
`逐字节一致` / `内容一致（仅行尾不同，非产物过期）` / `真不一致`。
**别让「仅行尾不同」冒充「不一致」（假红），也别让它冒充「一致」（放过真过期）。**
这与装机版验收是同一条判据（实践篇 §2.5-#10 / §3.1）：**看字节数差，先数 CR/LF。**

## 3. `verify-skill-descriptions.mjs` —— 描述不能漂

```powershell
node apps/fom-client/scripts/verify/verify-skill-descriptions.mjs
```

三件事一起验：① `index.ts` 的 `SKILLS` 常量 ↔ `assets/<name>/SKILL.md` 的 frontmatter
**逐字相等**；② **产物里那份也是对的**；③ slug 合法 + 顺序。

② 为什么单独验：esbuild 默认 `charset=ascii` ⇒ 产物里中文是 `\uXXXX` 转义，
**直接 grep 中文字串会 0 命中**（2026-11-05 真踩到：搜「三级加载」搜不到，
差点误判成没打进去）。本脚本把字面量解出来、解码后再比。

**主判据其实在 `plugins/office-skills/index.spec.ts`**（vitest 那条一致性测试）；
本脚本是同一判据的独立复现，给「本机没有内核检出、vitest 跑不了」的环境用。

## 4. `poll-release.mjs` —— 等 CI

```powershell
node apps/fom-client/scripts/verify/poll-release.mjs 42001807804        # 按 run id
node apps/fom-client/scripts/verify/poll-release.mjs --tag pkg-33       # 按 tag 找最新
```

每 45s 拉一次，只打**变化行**（run 状态 + 各 job 的当前步骤）。退出码 0 = success。
匿名调 GitHub API，限流 60 次/小时——四轮发版够用，别拿它做长驻监控。

---

## 相关

- 踩坑记录 §2.29（缓存失效只堵控制台写）、§2.30（手改产物＝假产物 + 两份描述只有一份有效）、
  §2.31（esbuild 的 `\uXXXX` 让「搜不到」变成假警报）
- 《[客户端打包与安装实践](../../../../docs/02-设计/客户端打包与安装实践v0.1.md)》——发版全流程与装机版三层验收
