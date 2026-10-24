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
  'scripts/check-sync-list.mjs',
  'scripts/check-release-workflow.mjs',
  'scripts/check-installer-brand.mjs',
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

  # ── 推送：HTTPS 不通时自动回落到 SSH ────────────────────────────────
  #
  # 2026-10-22 实测：`github.com` 的 **git over HTTPS 端点被阻断**
  # （`https://github.com/<repo>.git/info/refs` 超时），但 `api.github.com` 仍是 200、
  # `github.com:22` 也通。也就是说「仓库能不能访问」与「git 协议能不能走」是两件事，
  # 这种半通状态下重试 HTTPS 只会浪费时间（当时重试了十几次）。
  #
  # 判断方法（手工）：
  #   curl https://api.github.com/rate_limit          # 200
  #   curl https://github.com/<repo>.git/info/refs    # 超时 ⇒ 换 SSH
  #
  # 所以这里：HTTPS 失败且是 github.com 时，自动改写成 SSH 地址再试一次。
  # SSH 地址约定：https://github.com/<owner>/<repo>.git → git@github.com:<owner>/<repo>.git
  $pushUrl = $RemoteUrl
  git remote add origin $pushUrl
  git push -f origin $Branch 2>&1 | Out-Host
  if ($LASTEXITCODE -ne 0 -and $RemoteUrl -match '^https://github\.com/(.+?)(\.git)?$') {
    $slug = $Matches[1] -replace '\.git$',''
    $sshUrl = "git@github.com:$slug.git"
    Write-Host "⚠️ HTTPS 推送失败；改走 SSH：$sshUrl"
    Write-Host "   （github.com 的 git-over-HTTPS 被阻断时 api.github.com 仍可用，属半通状态）"
    git remote set-url origin $sshUrl
    $pushUrl = $sshUrl
    git push -f origin $Branch
    if ($LASTEXITCODE -ne 0) { throw "push 失败（HTTPS 与 SSH 都不通；先确认网络，别盲目重试）" }
  } elseif ($LASTEXITCODE -ne 0) {
    throw "push 失败（可重试；GitHub 偶发慢）"
  }
  if ($Tag -ne '') {
    git tag -f $Tag
    git push -f origin $Tag
    if ($LASTEXITCODE -ne 0) { throw "tag push 失败（重试时用同一个 $pushUrl）" }
    Write-Host "→ 已推 tag $Tag（触发 package workflow）"
  }
}
finally {
  Pop-Location
}

Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "✓ 桌面仓同步完成"
