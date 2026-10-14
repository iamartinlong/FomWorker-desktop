# fom-client · 客户端 agent

> **① 客户端 agent**：桌面（员工智能工作桌面）+ 本地插件 + 上报器。内核 dsh 桌面 + 我们的 bundle。
> 计划：`docs/02-设计/实施计划-客户端v0.1.md` · 集成：`docs/02-设计/客户端集成设计v0.1.md`。

## 目录（目标）

```
apps/fom-client/
├─ bundle/     # @fominfo/dsh-bundle-fomworker（dsh.bundle.patch 声明我们的插件）
├─ plugins/    # office-*（现 office-platform 迁入）+ office-reporter（新建）
├─ client/     # 登录 / 控制台面板 client module（浏览器端）
├─ desktop/    # 桌面壳（阶段 1 复用内核 apps/desktop；阶段 2 自有品牌壳）
└─ profile/    # profile 模板（bundles + 默认 patch）
```

## 状态

- **骨架：README（本文件）**。
- **已有资产**：`../../office-platform/`（office-* 插件，M1/M2；**待迁入 `plugins/`**）。
- **待建**：bundle、reporter、登录 client module、模型配置、打包。

## 里程碑

K0 骨架 → K1 登录 → K2 模型配置 → K3 上报器 → K4 本地治理 → K5 打包/更新。

## 依赖

- 内核 dsh（pin）。
- `packages/fom-contracts`（client↔platform WS、PLATFORM API）。
- `packages/fom-brand`。
