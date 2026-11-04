# 安装 / 卸载 dsh-skill-autopilot 到 DSH profile（web）
#
# 标准模式（默认）：写入 profile 的 package.json（link: 依赖 + dsh.profile.bundles），
# 再让 pnpm 建链接。可逆、可被 `dsh plugin` 管理。
#
# 免 pnpm 模式：只建一个 node_modules 软链 + 往 profile 的 cordis.patch.yml 追加一条
# insert 条目。不碰 package.json / lockfile，回滚只需删软链并还原 patch。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\install.ps1            # 标准模式
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Link      # 免 pnpm
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun    # 只打印计划
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Rollback  # 回滚（两种模式都认）
#
# 装完必须重启 DSH（重启由使用者自己执行）。

param(
    [string]$Profile = 'web',
    [switch]$Link,
    [switch]$DryRun,
    [switch]$Rollback
)

$ErrorActionPreference = 'Stop'
$pluginDir = $PSScriptRoot
$pluginName = 'dsh-skill-autopilot'
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome "profiles/$Profile"
$packageJson = Join-Path $profileDir 'package.json'
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
$nodeModules = Join-Path $profileDir 'node_modules'
$linkPath = Join-Path $nodeModules $pluginName
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

function Normalize([string]$p) { return ($p -replace '/', '\').TrimEnd('\') }

function Backup([string]$path) {
    $backup = "$path.bak-skill-autopilot-$stamp"
    Copy-Item -LiteralPath $path -Destination $backup -Force
    Write-Host "backup  $backup"
}

function Patch-Entry {
    return @"
    - id: skill-autopilot
      name: $pluginName
      config:
        enabled: true
        targetRoot: user-dsh
        reviewer:
          provider: ''
          model: ''
          maxTokens: 4096
        policy:
          minConfidence: 0.8
          minModelConfidence: 0.5
          maxNewPerRun: 2
          mergeSimilarity: 0.45
          descriptionMaxChars: 240
        autoApply: false
        intervalMinutes: 0
"@
}

if (-not (Test-Path -LiteralPath $packageJson)) {
    throw "找不到 profile：$profileDir（先跑一次 dsh --profile $Profile 让它初始化）"
}

# ------------------------------------------------------------------ rollback
if ($Rollback) {
    if (Test-Path -LiteralPath $linkPath) {
        $item = Get-Item -LiteralPath $linkPath -Force
        if ($item.LinkType) {
            [System.IO.Directory]::Delete($linkPath)
            Write-Host "removed link $linkPath"
        } else {
            Write-Host "refuse  $linkPath 不是软链/联接点，请手动确认后再删"
        }
    }
    $backups = Get-ChildItem -LiteralPath $profileDir -Filter 'package.json.bak-skill-autopilot-*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
    if ($backups) {
        Copy-Item -LiteralPath $backups[0].FullName -Destination $packageJson -Force
        Write-Host "restored $($backups[0].Name) -> package.json"
    }
    $patchBackups = Get-ChildItem -LiteralPath $profileDir -Filter 'cordis.patch.yml.bak-skill-autopilot-*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
    if ($patchBackups) {
        Copy-Item -LiteralPath $patchBackups[0].FullName -Destination $patchFile -Force
        Write-Host "restored $($patchBackups[0].Name) -> cordis.patch.yml"
    }
    if (-not $Link -and (Test-Path -LiteralPath $packageJson)) {
        Write-Host "PNPM   需要时手动执行：dsh plugin --profile $Profile install"
    }
    Write-Host 'rollback done; 重启后生效（重启由你执行）'
    exit 0
}

# -------------------------------------------------------------------- install
$normalizedPlugin = Normalize $pluginDir
$spec = "link:$normalizedPlugin"

if ($Link) {
    Write-Host "mode    link (no pnpm)"
    if ($DryRun) {
        Write-Host "plan    junction $linkPath -> $normalizedPlugin"
        Write-Host "plan    append insert entry to $patchFile"
        exit 0
    }
    if (-not (Test-Path -LiteralPath $nodeModules)) { New-Item -ItemType Directory -Path $nodeModules | Out-Null }
    if (Test-Path -LiteralPath $linkPath) {
        Write-Host "exists  $linkPath"
    } else {
        New-Item -ItemType Junction -Path $linkPath -Target $normalizedPlugin | Out-Null
        Write-Host "linked  $linkPath -> $normalizedPlugin"
    }
    $patchText = Get-Content -LiteralPath $patchFile -Raw
    if ($patchText -match [regex]::Escape($pluginName)) {
        Write-Host "exists  $patchFile 已含 $pluginName"
    } else {
        Backup $patchFile
        $block = @"
# [skill-autopilot] 技能进化自动审批（免 pnpm 模式注入）
- insert:
$(Patch-Entry)
"@
        if ($patchText.Trim() -eq '[]') {
            Set-Content -LiteralPath $patchFile -Value $block -Encoding UTF8
            Write-Host "wrote   $patchFile（替换空补丁层 []）"
        } else {
            Add-Content -LiteralPath $patchFile -Value "`n$block" -Encoding UTF8
            Write-Host "appended $patchFile"
        }
    }
} else {
    Write-Host "mode    pnpm (package.json + bundles)"
    if ($DryRun) {
        Write-Host "plan    dependencies += `"$pluginName`: `"$spec`""
        Write-Host "plan    dsh.profile.bundles += $pluginName"
        Write-Host "plan    dsh plugin --profile $Profile install"
        exit 0
    }
    $json = Get-Content -LiteralPath $packageJson -Raw | ConvertFrom-Json
    if (-not $json.PSObject.Properties['dependencies']) { $json | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) }
    $json.dependencies | Add-Member -NotePropertyName $pluginName -NotePropertyValue $spec -Force
    $bundles = @($json.dsh.profile.bundles)
    if ($bundles -notcontains $pluginName) {
        $json.dsh.profile.bundles = @($bundles + $pluginName)
    }
    Backup $packageJson
    $json | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $packageJson -Encoding UTF8
    Write-Host "wrote   $packageJson"
    Push-Location $profileDir
    try {
        & dsh plugin --profile $Profile install
    } finally {
        Pop-Location
    }
}

Write-Host ''
Write-Host 'preflight 验证组成（不启动）：'
Write-Host "  dsh --profile $Profile --dump-config | Select-String skill-autopilot"
Write-Host '生效需要重启 DSH；重启由你执行。'
