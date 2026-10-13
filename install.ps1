# dsh-turn-fold 安装脚本（只负责折叠）
# 纯插件安装：不改任何 @deepseek-ai/dsh-* 源码。
#   1) 把插件包链接进 profiles/node_modules（Junction；与 dsh-vision-opencode 同一约定）
#   2) 在 profiles/web/cordis.patch.yml 注册一行 insert（改前自动备份）
#   3) 重启 DSH 生效（**不要刷新已打开的页面**，见末尾说明）
#
# 注：更推荐用官方命令安装（见 README「安装」：`dsh plugin add` / npm 依赖），本脚本是
# 手工兜底路径。Junction 建在 **profiles 共享的 node_modules** 下（对每个 profile 都可见），
# 因此 `dsh plugin remove` 不会清理它——卸载时要手动删除该链接。
#
# 2026-10-13 评审修复：StrictMode 下缺字段不再先抛 PropertyNotFoundException（友好诊断可达）；
# profile 目录先校验后建目录；悬空 Junction 自动重建；改 patch 前备份；解析验证改从链接所在
# 目录做（profile 内的 npm 副本会把验证"遮"成假成功）。
[CmdletBinding()]
param(
  [string]$PluginSource,
  [string]$ProfileDir,
  [string]$DshHome
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# StrictMode 下 $obj.missing 会抛 PropertyNotFoundException（友好诊断永远走不到），
# 统一用 PSObject.Properties 显式取：缺失/父级为空一律返回 $null。
function Get-Prop($obj, [string]$name) {
  if ($null -eq $obj) { return $null }
  $prop = $obj.PSObject.Properties[$name]
  if ($null -eq $prop) { return $null }
  return $prop.Value
}

if (-not $DshHome) { $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' } }
if (-not $ProfileDir) { $ProfileDir = Join-Path $DshHome 'profiles\web' }
if (-not $PluginSource) { $PluginSource = $PSScriptRoot }
$PluginSource = (Resolve-Path -LiteralPath $PluginSource).Path

# profile 目录必须先存在：否则下面会先在共享的 profiles/ 下建出空目录再崩，
# 留下没有任何 profile 认领的残留（评审 2026-10-13）。
if (-not (Test-Path -LiteralPath $ProfileDir)) {
  throw "profile 目录不存在：$ProfileDir（先用官方命令把该 profile 建好，或显式传 -ProfileDir）"
}

# ---- 读取插件名 ----
$pkg = Get-Content -LiteralPath (Join-Path $PluginSource 'package.json') -Raw | ConvertFrom-Json
$name = $pkg.name
if (-not $name) { throw 'package.json missing "name"' }
$dshClient = Get-Prop (Get-Prop $pkg 'dsh') 'client'
if (-not $dshClient -or (Get-Prop $dshClient 'platform') -ne 'web') {
  throw "$name 缺少 dsh.client.platform = web 声明，DSH 客户端不会加载它"
}
if (-not (Get-Prop (Get-Prop $pkg 'exports') './client')) {
  throw "$name 缺少 exports['./client']，客户端模块系统找不到 bundle"
}

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

# ---- 1) 链接到 node_modules ----
$nmDir = Split-Path -Parent $ProfileDir
$target = Join-Path $nmDir 'node_modules'
if (-not (Test-Path -LiteralPath $target)) { New-Item -ItemType Directory -Path $target -Force | Out-Null }
$link = Join-Path $target $name
# scoped 包名（@scope/name）需要先建 @scope 父目录，mklink 不会自动创建
$linkParent = Split-Path -Parent $link
if (-not (Test-Path -LiteralPath $linkParent)) { New-Item -ItemType Directory -Path $linkParent -Force | Out-Null }

function New-PluginLink {
  cmd /c mklink /J "`"$link`"" "`"$PluginSource`"" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    # 无 Junction 权限时退化为复制
    Copy-Item -LiteralPath $PluginSource -Destination $link -Recurse -Force
    Write-Host "-> copied (junction unavailable): $link"
  } else {
    Write-Host "-> junction created: $link"
  }
}

if (Test-Path -LiteralPath $link) {
  $it = Get-Item -LiteralPath $link -Force
  $linkTarget = Get-Prop $it 'Target'
  $isJunction = (Get-Prop $it 'LinkType') -eq 'Junction'
  if ($isJunction -and ($linkTarget -eq $PluginSource)) {
    Write-Host "-> link OK (already exists): $link"
  } elseif ($isJunction -and -not (Test-Path -LiteralPath $linkTarget)) {
    # 悬空 Junction：Test-Path 对"链接存在但目标已删除"返回 True，此前会硬失败并要求
    # 用户手动删除（本机 profiles/node_modules 下就有这种残留，来自已删除的旧路径）。
    # 删链接本身是安全的——[IO.Directory]::Delete 只删 Junction 不跟随目标。
    Write-Host "-> 悬空 Junction（目标已不存在：$linkTarget）→ 删除重建"
    [IO.Directory]::Delete($link)
    New-PluginLink
  } else {
    throw "目标已存在但不是指向本插件的 Junction：$link （请先手动删除再重跑）"
  }
} else {
  New-PluginLink
}

# ---- 验证 require 能解析到 ----
# 从**链接所在目录**解析：profile 自己的 node_modules 里若已有同名 npm 副本，
# 从 $ProfileDir 解析会命中那份副本，把"链接其实没生效"验成成功（评审 2026-10-13）。
Push-Location $nmDir
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
  if (Test-Path -LiteralPath $patchFile) {
    # 改前备份：patch 是用户手写文件，改坏了没有 undo（评审 2026-10-13）
    $backup = $patchFile + '.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Copy-Item -LiteralPath $patchFile -Destination $backup -Force
    Write-Host "-> backup: $backup"
  }
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
Write-Host '  ⚠️ 不要刷新"改动之前就已经打开"的页面：宿主在启动时算出每个插件 bundle 的 rev，'
Write-Host '     旧页面拿旧 rev 去取会 404，页面会永久停在 "HARNESS Loading plugins…"。'
Write-Host '     重启应用（或等已打开页面的热更新）才是正确姿势。'
Write-Host "卸载：删除链接 $link，并删掉 $patchFile 里对应的 insert 块（备份文件见同目录 .bak-*）。"
Write-Host '验证：新会话里让模型执行几步工具调用 + 一个 Think，观察工具调用是否在下一个 Think 后自动折叠成组。'
