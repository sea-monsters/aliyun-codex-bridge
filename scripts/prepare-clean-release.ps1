Param(
  [switch]$WhatIfOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot

$patterns = @(
  "response.log",
  "logs\*.log",
  "*.tmp",
  "tmp\*"
)

Write-Host "[clean] root=$root"
foreach ($pattern in $patterns) {
  $path = Join-Path $root $pattern
  $items = Get-ChildItem -Path $path -Force -ErrorAction SilentlyContinue
  foreach ($item in $items) {
    if ($WhatIfOnly) {
      Write-Host "[clean] would remove $($item.FullName)"
    } else {
      Remove-Item -Path $item.FullName -Force -Recurse -ErrorAction SilentlyContinue
      Write-Host "[clean] removed $($item.FullName)"
    }
  }
}

Write-Host "[clean] done"

