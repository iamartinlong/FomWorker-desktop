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

## 2. `replay-host-halves.mjs` —— 产物新鲜度探测器（**host 半**）

> ⚠️ 只覆盖 `HOST_ONLY` 那 12 个插件的 `lib/index.js`。**双半插件的 client 半不归它管**，
> 见 §2b——2026-11-06 `pkg-36` 就是只跑了这把、漏了 client 半。

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

## 2b. `check-client-halves.mjs` —— client 半产物新鲜度

双半插件（有 `dsh.client` 的）共 4 个：`office-console` / `office-login` /
`office-assistant` / `ui-brand-fomworker`。它们的 `lib/client.js` 走 **tsdown**，
**不在** `build-host-halves.mjs` 的 `HOST_ONLY` 列表里 ⇒ 需要单独一把门禁。

```powershell
node apps/fom-client/scripts/verify/check-client-halves.mjs
```

**判据是「src 不比 lib 新」，不是字节重放**。试过 6 种字节重放方案全差一口气，
根因是**开发机与 CI 的模块解析形状不同**：开发机上 `@fominfo/dsh-ui` 是 junction，
Node/rolldown 会**还原成真实路径**（`apps/fom-client/ui/src/Card.tsx`）；
CI 里 symlink 与 junction 都还原不了（`node_modules/@fominfo/dsh-ui/src/…`）
⇒ 产物里的模块注释必然不同。这是环境固有差异，硬凑字节一致是在和自己的工具链打仗。

而这道门禁的**目的只是「防忘了重建」**，两个判据就够：
- **本地**：`src/` 下最新文件 mtime > `lib/client.js` mtime ⇒ 红；
- **CI**（git checkout 会重置 mtime）：`src/` 的最后提交时间 > `lib/` 的最后提交时间 ⇒ 红。
  ⚠️ 判据必须是**提交时间**，不能比 SHA 大小——SHA 字典序与时间序无关
  （实测 `2e5bba6` 晚于 `41917e1` 发生，字典序却更小）。

两个判据都做过反向回归：造一个只改 `src/` 的提交 ⇒ 必红、还原后复绿。

**为什么有这把**：2026-11-06 `pkg-36` 装机后「配置 / 新建连接器」按钮不出现，
根因是七批新代码只重放了 host 半，`office-console/lib/client.js` 从没重建过
（host 新、界面旧）。**知道踩坑 §2.6，却让门禁的覆盖面替自己做判断**——
现在两把门禁都接进了 CI 的 `package.yml`。

### 2b-ii. 第二道判据：externals drift（2026-11-06 `pkg-39` 装机即崩换来的）

上面那道判据**防得住「忘了重建」，防不住「重建了却重建错了」**。
`pkg-39` 装机后 web boot 直接挂，崩溃日志：

```
Error: web boot: 1 entry did not activate
@office/console: import failed: client-modules: require("@fominio/dsh-ui") missed the module table
```

根因是 `ConnectorConfigDialog.tsx` 把包名**写错一个字母**——`@fominio/dsh-ui`，
真名 `@fominfo/dsh-ui`（少一个 `f`）。开发机上这个包根本不存在，
**rolldown 解析失败时不报错**，只是把它留成外部 `require(...)`；
mtime 判据看到「lib 比 src 新」照样放行。装机后运行时模块表里没这一项
⇒ `require` 抛错 ⇒ client 入口激活失败 ⇒ web boot 挂。

**判据因此是硬的、可枚举的**：产物里允许出现的 `require` ＝

- **平台种子词** `PLATFORM_MODULES`（壳预置进冻结模块表的；读内核
  `packages/client/web/src/platform.ts`，内核没检出时用内置兜底并把来源打出来）；
- **∪** 本插件 `tsdown.config.ts` 的 `external` 白名单。

除此之外任何一个 `require("...")` 都是 build-time externals drift。

**它当场就抓到了第二例**：`office-login` 的产物里有 `require("react-dom")`，
而它的 `external` 只写了 `/^react($|\/)/`（不匹配 `react-dom`）。
查证 `PLATFORM_MODULES` 里**确实有** `react-dom` ⇒ 它不是活缺陷，只是**未声明**——
所以判据要把平台种子词算进白名单，否则会误报。

**反向回归三个场景**（全部按预期）：
① 往产物里塞错拼包的 require ⇒ 红；② 塞一个来历不明的 require ⇒ 红；
③ 塞平台种子词 `react-dom` ⇒ **必须放行**（证明门禁不会太紧）。
复原后正向复跑 exit=0。

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
