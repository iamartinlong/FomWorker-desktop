# fom-client · 客户端 agent

> **① 客户端 agent**：桌面（员工智能工作桌面）+ 本地插件 + 上报器。内核 dsh 桌面 + 我们的 bundle。
> 计划：`docs/02-设计/实施计划-客户端v0.1.md` · 集成：`docs/02-设计/客户端集成设计v0.1.md`。

## 目录

```
apps/fom-client/
├─ bundle/     # @fominfo/dsh-bundle-fomworker（dsh.bundle.patch 声明我们的插件）
├─ plugins/    # office-*（已从 office-platform 迁入）+ ui-brand-fomworker / office-login / office-reporter
├─ ui/         # @fominfo/dsh-ui（自有组合层：组合内核 ui-primitives 原子 + --dsw-alias-* 令牌；补内核缺的 Textarea/Card）
├─ build/      # css-modules.mjs（out-of-tree CSS Modules 管线：lightningcss → 幂等 style 注入）
├─ scripts/    # link-deps.ps1（重建环境 junction）
├─ client/     # 登录 / 控制台面板 client module（浏览器端）〔待建〕
├─ desktop/    # 桌面壳（阶段 1 复用内核 apps/desktop；阶段 2 自有品牌壳）〔待建〕
├─ *.patch.yml # office 插件的挂载件（--patch）
├─ .spike/     # 真进程观测 / 变异检验仪器
├─ package.json / tsconfig.json / vitest.config.ts
└─ profile/    # profile 模板（bundles + 默认 patch）〔待建〕
```

## 环境接线（junction，不入库）

`node_modules` 不入库。**新克隆 / 换机后跑一次**：

```sh
pwsh -File apps/fom-client/scripts/link-deps.ps1          # 含运行期 profile 链接
pwsh -File apps/fom-client/scripts/link-deps.ps1 -SkipProfile   # 只建仓库内链接
```

建三类链接（幂等）：① 内核包 → `node_modules/@deepseek-ai/*`；② 自有包 → `@fominfo/dsh-ui` + `ui/node_modules/{react,react-dom,@types/*}`；③ 运行期 profile → `$DSH_HOME/profiles/node_modules/{@office,@fominfo}/*`。原则见 `docs/02-设计/前端技术栈与页面实现规范v0.1.md` §3.6。

## 构建产物（`lib/`，入库）

插件 `lib/` 是**构建产物但入库**（照 `ui-brand-fomworker` 先例）——打包/CI 直接取用，**不在 CI 里装依赖**（产品根禁装；插件各自带 node_modules）。**改了插件源码（`.tsx` / `.module.css` / host `.ts`）后必须重跑**：

```sh
pwsh -File apps/fom-client/scripts/build-bundles.ps1   # office-console / office-login / ui-brand-fomworker
node apps/fom-client/scripts/build-host-halves.mjs    # catalog / authz / console / experts / skills 的 host 半
```

⚠️ **host 半**：办公插件的 host 入口（`index.ts`）由 **esbuild** 转译成 `lib/index.js`（打包运行时**无 tsx**，Loader 只认 JS）——`package.json` 的 `exports["."]` 指向 `lib/index.js`；改了 host 源码须重跑 `build-host-halves.mjs`。**打包覆盖层**（`branding/apply-packaging-overlay.mjs`）把 `@fominfo/*` + `@office/*` 全部 stage 进运行时，bundle patch 用**完整行**（品牌 + 登录 + 办公插件），并**护栏**：声明了入口的包产物缺失即失败。

## 状态

- **骨架：README（本文件）**。
- **已迁入**：`office-platform/` 已并入本目录——`plugins/` 下是 office-* 插件（M1/M2）+ `ui-brand-fomworker` / `office-login` / `office-reporter`；门禁 `tsc` **0** + `vitest`（**69 文件 / 568 例**）。
- **UI 组合层**：`ui/`（`@fominfo/dsh-ui`，`Textarea`/`Card`）；`office-console` + `office-login` 已接内核 `ui-primitives` + `--dsw-alias-*` 令牌 + **CSS Modules**（见前端规范 §3.5/§3.6/§3.7）。
- **CSS Modules 管线**：`build/css-modules.mjs`（自写 rolldown 插件：`*.module.css` → lightningcss 编译 → 幂等 style 注入 + 类名映射，消费方无需 CSS 管线）；各插件 `tsdown.config.ts` 的 `plugins: [cssModulesPlugin('<包名>')]` 引入。
- **待建**：`client/`、`desktop/`、`profile/`。

## 里程碑

K0 骨架 → K1 登录 → K2 模型配置 → K3 上报器 → K4 本地治理 → K5 打包/更新。

## 依赖

- 内核 dsh（pin）。
- `packages/fom-contracts`（client↔platform WS、PLATFORM API）。
- `packages/fom-brand`。
