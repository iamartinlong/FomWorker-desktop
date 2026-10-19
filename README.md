# FomWorker Desktop（打包仓）

**仅用于桌面端打包**（GitHub Actions）。由 monorepo 的 `scripts/sync-desktop-repo.ps1` 导出。

- 内核（`deepseek-harness`）由 workflow 从公开仓克隆。
- 本仓只含**桌面打包输入**（`apps/fom-client` / `packages/fom-{contracts,brand}` / `branding` + 打包 workflow）。
- **不含** `docs/`、`apps/fom-gateway/`、`apps/fom-platform/`。
