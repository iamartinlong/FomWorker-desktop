<#
.SYNOPSIS
  重建 FomWorker 客户端（apps/fom-client）的环境 junction。

.DESCRIPTION
  node_modules 不入库；新克隆 / 换机后跑一次即可（幂等：已存在则跳过）。
  三类链接：
    1) 内核包  → apps/fom-client/node_modules/@deepseek-ai/*
    2) 自有包  → @fominfo/dsh-ui（apps/fom-client/ui）+ ui 包的 react/@types
    3) 运行期 profile 链接 → $DSH_HOME/profiles/node_modules/{@office,@fominfo}/*

  背景见 docs/02-设计/前端技术栈与页面实现规范v0.1.md §3.6。

.EXAMPLE
  pwsh -File apps/fom-client/scripts/link-deps.ps1
.EXAMPLE
  pwsh -File apps/fom-client/scripts/link-deps.ps1 -SkipProfile
#>
[CmdletBinding()]
param(
  # 仓库根（默认由脚本位置推出）。
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path,
  # dsh home（默认 $env:DSH_HOME 或 ~/.dsh）。
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
  # 跳过运行期 profile 链接。
  [switch]$SkipProfile
)

$ErrorActionPreference = 'Stop'
$client = Join-Path $RepoRoot 'apps\fom-client'
$kernel = Join-Path $RepoRoot 'deepseek-harness'

# 内核包 → @deepseek-ai/<name>（相对 deepseek-harness/）。
$kernelLinks = [ordered]@{
  'cordis'                 = 'vendor\cordis'
  'schemastery'            = 'vendor\schemastery'
  'dsh-agent'              = 'packages\core\agent'
  'dsh-agent-loop'         = 'packages\core\agent-loop'
  'dsh-session'            = 'packages\core\session'
  'dsh-system-prompt'      = 'packages\core\system-prompt'
  'dsh-tools'              = 'packages\core\tools'
  'dsh-llm'                = 'packages\llm\llm'
  'dsh-schedule'           = 'packages\schedule\schedule'
  'dsh-session-projection' = 'packages\session\session-projection'
  'dsh-skill'              = 'packages\skill\skill'
  'dsh-storage'            = 'packages\storage\storage'
  'dsh-storage-domain'     = 'packages\storage\storage-domain'
  'dsh-storage-json'       = 'packages\storage\storage-json'
  'dsh-user-approval'      = 'packages\interaction\user-approval'
  'dsh-client-ui-primitives' = 'packages\client\ui-primitives'
}

function New-Junction {
  param([string]$Path, [string]$Target, [string]$Label)
  if (-not (Test-Path -LiteralPath $Target)) { Write-Warning "跳过 $Label：目标不存在 $Target"; return }
  if (Test-Path -LiteralPath $Path) { Write-Host "  已有 $Label"; return }
  New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
  New-Item -ItemType Junction -Path $Path -Target $Target | Out-Null
  Write-Host "  建   $Label"
}

# 在 .pnpm 里按通配找包（对版本号漂移稳健）。
function Resolve-PnpmPackage {
  param([string]$Store, [string]$Pattern)
  $hit = Get-ChildItem -Path (Join-Path $Store '.pnpm') -Directory -Filter $Pattern -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
  if ($null -eq $hit) { return $null }
  return $hit.FullName
}

Write-Host "[1/3] 内核包 → apps/fom-client/node_modules/@deepseek-ai"
foreach ($name in $kernelLinks.Keys) {
  New-Junction -Path (Join-Path $client "node_modules\@deepseek-ai\$name") `
    -Target (Join-Path $kernel $kernelLinks[$name]) -Label "@deepseek-ai/$name"
}

Write-Host "[2/3] 自有包 + ui 包依赖"
New-Junction -Path (Join-Path $client 'node_modules\@fominfo\dsh-ui') -Target (Join-Path $client 'ui') -Label '@fominfo/dsh-ui'

$store = Join-Path $kernel 'node_modules'
$uiDeps = [ordered]@{
  'react'                 = (Resolve-PnpmPackage $store 'react@*')
  'react-dom'             = (Resolve-PnpmPackage $store 'react-dom@*')
  '@types\react'          = (Resolve-PnpmPackage $store '@types+react@*')
  '@types\react-dom'      = (Resolve-PnpmPackage $store '@types+react-dom@*')
  '@types\node'           = (Resolve-PnpmPackage $store '@types+node@*')
}
foreach ($rel in $uiDeps.Keys) {
  $found = $uiDeps[$rel]
  if ($null -eq $found) { Write-Warning "跳过 ui/node_modules/$rel：.pnpm 里没找到"; continue }
  # .pnpm 目录形如 react@18.3.1（或 react-dom@18.3.1_react@18.3.1），包体在其 node_modules/ 下。
  $target = Join-Path (Join-Path $found 'node_modules') $rel
  New-Junction -Path (Join-Path $client "ui\node_modules\$rel") -Target $target -Label "ui/$rel"
}

# 构建依赖：CSS Modules 管线（apps/fom-client/build/css-modules.mjs 用 lightningcss）。
New-Junction -Path (Join-Path $client 'node_modules\lightningcss') -Target (Join-Path $kernel 'node_modules\lightningcss') -Label 'lightningcss'
# 构建依赖：host 半产物（scripts/build-host-halves.mjs 用 esbuild）。
$esbuild = Resolve-PnpmPackage $store 'esbuild@*'
if ($null -eq $esbuild) {
  Write-Warning '跳过 esbuild：.pnpm 里没找到'
} else {
  New-Junction -Path (Join-Path $client 'node_modules\esbuild') -Target $esbuild -Label 'esbuild'
}

if ($SkipProfile) {
  Write-Host "[3/3] 跳过 profile 链接（-SkipProfile）"
} else {
  Write-Host "[3/3] 运行期 profile 链接 → $DshHome\profiles\node_modules"
  $profile = Join-Path $DshHome 'profiles\node_modules'
  $officeLinks = [ordered]@{
    'authz'    = 'plugins\office-authz'
    'catalog'  = 'plugins\office-catalog'
    'console'  = 'plugins\office-console'
    'experts'  = 'plugins\office-experts'
    'skills'   = 'plugins\office-skills'
    'approval' = 'plugins\office-approval'
    'feishu'   = 'plugins\office-feishu'
    'billing'  = 'plugins\office-billing'
    'channel'  = 'plugins\office-channel'
  'delegate' = 'plugins\office-delegate'
  'tasks'    = 'plugins\office-tasks'
  'assistant' = 'plugins\office-assistant'
    'reporter' = 'plugins\office-reporter'
  }
  foreach ($name in $officeLinks.Keys) {
    New-Junction -Path (Join-Path $profile "@office\$name") `
      -Target (Join-Path $client $officeLinks[$name]) -Label "@office/$name"
  }
  $fominfoLinks = [ordered]@{
    'dsh-bundle-fomworker'          = 'bundle'
    'dsh-client-ui-brand-fomworker' = 'plugins\ui-brand-fomworker'
    'dsh-client-ui-login'           = 'plugins\office-login'
  }
  foreach ($name in $fominfoLinks.Keys) {
    New-Junction -Path (Join-Path $profile "@fominfo\$name") `
      -Target (Join-Path $client $fominfoLinks[$name]) -Label "@fominfo/$name"
  }
}

Write-Host '完成。'
