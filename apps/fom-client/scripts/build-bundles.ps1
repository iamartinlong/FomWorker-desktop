<#
.SYNOPSIS
  重建 FomWorker 客户端各插件的 `lib/` 产物。

.DESCRIPTION
  插件的 `lib/` 是**构建产物但入库**（照 `ui-brand-fomworker` 先例）——打包/CI 直接取用，
  不在 CI 里 `pnpm install`（产品根禁装依赖；插件各自带 node_modules）。
  **改了插件源码（含 `.tsx` / `.module.css`）后必须重跑本脚本**，否则打包取到旧产物。

.EXAMPLE
  pwsh -File apps/fom-client/scripts/build-bundles.ps1
#>
[CmdletBinding()]
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
)

$ErrorActionPreference = 'Stop'
$plugins = Join-Path $RepoRoot 'apps\fom-client\plugins'
$failed = @()

foreach ($name in @('office-console', 'office-login', 'office-assistant', 'ui-brand-fomworker')) {
  $dir = Join-Path $plugins $name
  $tsdown = Join-Path $dir 'node_modules\.bin\tsdown.CMD'
  if (-not (Test-Path -LiteralPath $tsdown)) {
    Write-Warning "跳过 $name：没有本地 tsdown（先在该插件目录 pnpm install）"
    $failed += $name
    continue
  }
  Write-Host "== $name =="
  Push-Location $dir
  try {
    & $tsdown
    if ($LASTEXITCODE -ne 0) { throw "$name 构建失败（exit $LASTEXITCODE）" }
  } finally {
    Pop-Location
  }
}

if ($failed.Count -gt 0) {
  Write-Warning "未构建：$($failed -join ', ')"
  exit 1
}
Write-Host '完成。'
