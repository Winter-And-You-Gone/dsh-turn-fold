# dsh-turn-fold 安装脚本（只负责折叠）
# 纯插件安装：不改任何 @deepseek-ai/dsh-* 源码。
#   1) 把插件包放进 profile 的 node_modules（Junction 链接，与 dsh-vision-opencode 同一约定）
#   2) 在 profiles/web/cordis.patch.yml 注册一行 insert
#   3) 重启 dsh + 刷新浏览器生效
[CmdletBinding()]
param(
  [string]$PluginSource,
  [string]$ProfileDir,
  [string]$DshHome
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $DshHome) { $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' } }
if (-not $ProfileDir) { $ProfileDir = Join-Path $DshHome 'profiles\web' }
if (-not $PluginSource) { $PluginSource = $PSScriptRoot }
$PluginSource = (Resolve-Path -LiteralPath $PluginSource).Path

# ---- 读取插件名 ----
$pkg = Get-Content -LiteralPath (Join-Path $PluginSource 'package.json') -Raw | ConvertFrom-Json
$name = $pkg.name
if (-not $name) { throw 'package.json missing "name"' }
if (-not $pkg.'dsh'.client -or $pkg.'dsh'.client.platform -ne 'web') {
  throw "$name 缺少 dsh.client.platform = web 声明，DSH 客户端不会加载它"
}
if (-not $pkg.exports.'./client') { throw "$name 缺少 exports['./client']，客户端模块系统找不到 bundle" }

# 入口 id 是插件的稳定标识（client.js 按它注册、bundle 补丁按它插入），
# 与 npm 包名无关——scoped 包名（如 @scope/name）不得作为 id 使用。
# 从插件自带的 bundle 补丁里读第一个 `- id:`，读不到时回退到包名。
$entryId = $name
$bundlePatch = Join-Path $PluginSource 'cordis.patch.yml'
if (Test-Path -LiteralPath $bundlePatch) {
  $idMatch = [regex]::Match([IO.File]::ReadAllText($bundlePatch), '(?m)^\s*-\s+id:\s*([^\s#]+)')
  if ($idMatch.Success) { $entryId = $idMatch.Groups[1].Value.Trim().Trim("'").Trim('"') }
}

Write-Host "-> plugin : $name ($PluginSource)"
Write-Host "-> entry  : $entryId"
Write-Host "-> profile: $ProfileDir"

# ---- 1) 链接到 profile node_modules ----
$nmDir = Split-Path -Parent $ProfileDir
$target = Join-Path $nmDir ('node_modules' ) 
if (-not (Test-Path -LiteralPath $target)) { New-Item -ItemType Directory -Path $target -Force | Out-Null }
$link = Join-Path $target $name
# scoped 包名（@scope/name）需要先建 @scope 父目录，mklink 不会自动创建
$linkParent = Split-Path -Parent $link
if (-not (Test-Path -LiteralPath $linkParent)) { New-Item -ItemType Directory -Path $linkParent -Force | Out-Null }
if (Test-Path -LiteralPath $link) {
  $it = Get-Item -LiteralPath $link -Force
  if ($it.LinkType -eq 'Junction' -and $it.Target -eq $PluginSource) {
    Write-Host "-> link OK (already exists): $link"
  } else {
    throw "目标已存在但不是指向本插件的 Junction：$link （请先手动删除再重跑）"
  }
} else {
  cmd /c mklink /J "`"$link`"" "`"$PluginSource`"" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    # 无 Junction 权限时退化为复制
    Copy-Item -LiteralPath $PluginSource -Destination $link -Recurse -Force
    Write-Host "-> copied (junction unavailable): $link"
  } else {
    Write-Host "-> junction created: $link"
  }
}

# ---- 验证 require 能解析到 ----
Push-Location $ProfileDir
try {
  $resolved = node -e "console.log(require.resolve('$name/package.json'))" 2>$null
  if (-not $resolved) { throw "require.resolve('$name') 失败——DSH 客户端模块系统将无法加载" }
  Write-Host "-> resolvable: $resolved"
} finally {
  Pop-Location
}

# ---- 2) 注册到 cordis.patch.yml ----
$patchFile = Join-Path $ProfileDir 'cordis.patch.yml'
$patchText = if (Test-Path -LiteralPath $patchFile) { [IO.File]::ReadAllText($patchFile) } else { '' }
# 去掉文件顶部可能的空 `[]`（空 profile 占位）
$patchText = [regex]::Replace($patchText, '(?m)^\s*\[\s*\]\s*\r?\n?', '')
if ($patchText -notmatch "(?m)^\s*- id: $([regex]::Escape($entryId))\s*$") {
  $patchText = $patchText.TrimEnd() + "`n`n- insert:`n    - id: $entryId`n      name: '$name'`n"
  [IO.File]::WriteAllText($patchFile, $patchText, [Text.UTF8Encoding]::new($false))
  Write-Host "-> registered in $patchFile"
} else {
  Write-Host "-> already registered in $patchFile"
}

Write-Host ''
Write-Host '安装完成。下一步：'
Write-Host '  1) 完全退出 DSH（不是关窗口，是结束 dsh 进程）'
Write-Host '  2) 重新启动 DSH，打开同一会话'
Write-Host '  3) 浏览器刷新页面（若 DSH 自带窗口则重启即可）'
Write-Host '验证：新会话里让模型执行几步工具调用 + 一个 Think，观察工具调用是否在下一个 Think 后自动折叠成组。'
