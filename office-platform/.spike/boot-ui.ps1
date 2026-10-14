# Boot a UI-acceptance instance (profile B: approval + feishu tools + skills + memory + office skills)
#
# Usage (PowerShell, any directory). Prefer PowerShell 7 (`pwsh`):
#   pwsh -ExecutionPolicy Bypass -File "F:/deepseek/deepseek harness/office-platform/.spike/boot-ui.ps1"
# Windows PowerShell 5.1 also works:
#   powershell -ExecutionPolicy Bypass -File "F:/deepseek/deepseek harness/office-platform/.spike/boot-ui.ps1"
# Optional port:  ... -File .spike/boot-ui.ps1 -Port 3095
#
# It prints a line `dsh web: http://127.0.0.1:<port>/?token=...` -- open THAT url in the browser.
#
# Why a script: `pnpm dsh web --patch ./office.patch.yml` mounts ONLY the office document skills;
# none of the product plugins (approval / memory / feishu tools / skills) are loaded, so tools like
# memory_write and feishu_doc_read do not exist in the session. This script mounts all four product patches.
#
# ASCII-only on purpose: PowerShell 5.1 reads a UTF-8-without-BOM file as ANSI/GBK and mis-decodes
# non-ASCII bytes, which corrupts parsing. Keep this file ASCII. Also no backtick line-continuation
# (it breaks on LF line endings); args are assembled in an array and splatted instead.
param([int]$Port = 3095)

$ErrorActionPreference = 'Stop'
$OP = 'F:/deepseek/deepseek harness/office-platform'
$DSH = 'F:\deepseek\deepseek harness\deepseek-harness'

# Feishu App Secret: set only in this process, never on the command line or in logs.
$secret = ((Get-Content "$OP/.secrets/feishu-dev.env" | Where-Object { $_ -match '^FEISHU_APP_SECRET=' }) -split '=', 2)[1].Trim()
if ([string]::IsNullOrWhiteSpace($secret)) { throw "no FEISHU_APP_SECRET found in $OP/.secrets/feishu-dev.env" }
$env:FEISHU_APP_SECRET = $secret

Write-Host "booting UI-acceptance instance (profile B) on port $Port ... cold start ~40-100s" -ForegroundColor Cyan

$patches = @(
  "$OP/office-approval.patch.yml",
  "$OP/office-feishu.patch.yml",
  "$OP/office-skills.patch.yml",
  "$OP/office-memory.spike.patch.yml",
  "./office.patch.yml"
)
$webArgs = @('web')
foreach ($patch in $patches) { $webArgs += @('--patch', $patch) }
$webArgs += @('--port', "$Port")

Set-Location $DSH
& pnpm dsh @webArgs
