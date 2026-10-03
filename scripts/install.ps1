#Requires -Version 5.1
<#
.SYNOPSIS
  安装 biaodian（中文标点校对）技能到各 AI 编码平台。

.EXAMPLE
  .\scripts\install.ps1 -All
  .\scripts\install.ps1 -Target codex,claude -Force
#>
[CmdletBinding()]
param(
  [string[]]$Target,
  [switch]$All,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$SkillDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

function Get-TargetRoot([string]$Name) {
  switch ($Name) {
    'codex'      { Join-Path $HOME '.codex/skills' }
    'claude'     { Join-Path $HOME '.claude/skills' }
    'opencode'   { Join-Path $HOME '.config/opencode/skills' }
    'trae-code'  { Join-Path $HOME '.trae-cn/skills' }
    'trae-cli'   { Join-Path $HOME '.traecli/skills' }
    'kimi-cli'   { Join-Path $HOME '.kimi/skills' }
    'kimi-code'  { Join-Path $HOME '.kimi-code/skills' }
    'workbuddy'  { Join-Path $HOME '.workbuddy/skills' }
    'zcode'      { Join-Path $HOME '.zcode/skills' }
    default      { throw "Unsupported target: $Name" }
  }
}

$targets = @()
if ($All) { $targets += @('codex','claude','opencode','trae-code','trae-cli','kimi-cli','kimi-code','workbuddy','zcode') }
if ($Target) { $targets += $Target }
if (-not $targets) { throw 'Nothing to do. Use -All or -Target <name>.' }

foreach ($name in $targets) {
  $root = Get-TargetRoot $name
  $destination = Join-Path $root 'biaodian'
  New-Item -ItemType Directory -Force -Path $root | Out-Null

  if (Test-Path $destination) {
    if (-not $Force) {
      Write-Error "Refusing to replace existing $destination; rerun with -Force after review."
      exit 3
    }
    Remove-Item -Recurse -Force $destination
  }

  # Windows 默认复制目录，避免依赖管理员权限或开发者模式。
  Copy-Item -Recurse -Force $SkillDir $destination
  if (-not (Test-Path (Join-Path $destination 'SKILL.md'))) { throw "Install failed: $destination" }
  Write-Host "Installed: $name -> $destination"
}
