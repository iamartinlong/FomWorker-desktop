# 把 monorepo 的「桌面打包输入」导出并推送到**独立 GitHub 桌面仓**。
#
# 背景：GitHub 只用于**桌面打包**；docs/网关/平台**不**上 GitHub。
# 本脚本用 `git archive` 从 monorepo 导出**仅桌面相关路径**（尊重 .gitignore，不带 node_modules/.spike），
# 在临时目录重建为单提交仓库，再 push 到桌面仓。
#
# 用法：
#   pwsh -File scripts/sync-desktop-repo.ps1 -RemoteUrl https://github.com/<user>/FomWorker-desktop.git
param(
  [Parameter(Mandatory = $true)][string]$RemoteUrl,
  [string]$Branch = 'master',
  # 可选：推一个 tag（如 pkg-1）以**触发桌面打包 workflow**（无需 PAT）。
  [string]$Tag = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# 桌面打包输入（**不含** docs/ apps/fom-gateway/ apps/fom-platform/）
$paths = @(
  'apps/fom-client',
  'packages/fom-contracts',
  'packages/fom-brand',
  'branding',
  '.github/workflows/package.yml',
  'scripts/check-contracts.mjs',
  'scripts/check-packaging.mjs',
  'scripts/check-kernel-host.mjs',
  'scripts/check-sync-list.mjs',
  'scripts/verify-installer.mjs',
  'scripts/sync-desktop-repo.ps1'
)

$stage = Join-Path $env:TEMP ("fom-desktop-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
Write-Host "→ 导出到临时目录：$stage"

Push-Location $root
try {
  # git archive 只导出 tracked 文件（自动排除 node_modules/.spike 等 gitignored）
  $args = @('archive', '--format=tar', $Branch, '--') + $paths
  git @args | tar -x -C $stage
  if ($LASTEXITCODE -ne 0) { throw "git archive 失败" }
}
finally {
  Pop-Location
}

# 桌面仓 README
$readme = @'
# FomWorker Desktop（打包仓）

**仅用于桌面端打包**（GitHub Actions）。由 monorepo 的 `scripts/sync-desktop-repo.ps1` 导出。

- 内核（`deepseek-harness`）由 workflow 从公开仓克隆。
- 本仓只含**桌面打包输入**（`apps/fom-client` / `packages/fom-{contracts,brand}` / `branding` + 打包 workflow）。
- **不含** `docs/`、`apps/fom-gateway/`、`apps/fom-platform/`。
'@
Set-Content -Path (Join-Path $stage 'README.md') -Value $readme -Encoding utf8

Write-Host "→ 初始化 + 提交 + 推送 $RemoteUrl ($Branch) ..."
Push-Location $stage
try {
  git init -b $Branch | Out-Null
  git add -A
  git -c user.name='fom-ci' -c user.email='ci@fominfo.com' commit -m "desktop packaging snapshot: $(Get-Date -Format o)" | Out-Null
  git remote add origin $RemoteUrl
  git push -f origin $Branch
  if ($LASTEXITCODE -ne 0) { throw "push 失败（可重试；GitHub 偶发慢）" }
  if ($Tag -ne '') {
    git tag -f $Tag
    git push -f origin $Tag
    if ($LASTEXITCODE -ne 0) { throw "tag push 失败（可重试）" }
    Write-Host "→ 已推 tag $Tag（触发 package workflow）"
  }
}
finally {
  Pop-Location
}

Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "✓ 桌面仓同步完成"
