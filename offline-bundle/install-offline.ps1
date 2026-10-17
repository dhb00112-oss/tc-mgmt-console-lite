param(
    [string]$InstallRoot = 'D:\Apps\mgmt-console-lite'
)

$ErrorActionPreference = 'Stop'

# Upgrade helper: when an existing config.json is preserved, add the optional
# fields introduced by newer versions (without touching existing values) so an
# old installation becomes fully current with a single install run.
function Add-Missing-Config-Fields {
    param([string]$Path)
    $config = [System.IO.File]::ReadAllText($Path) | ConvertFrom-Json
    $added = New-Object System.Collections.Generic.List[string]

    if (-not ($config.PSObject.Properties['mode'])) {
        $config | Add-Member -NotePropertyName mode -NotePropertyValue 'command'
        $added.Add('mode = command  (真实 JMX 模式)') | Out-Null
    }

    if (-not ($config.PSObject.Properties['adapter'])) {
        $config | Add-Member -NotePropertyName adapter -NotePropertyValue ([pscustomobject]@{})
    }
    if (-not ($config.adapter.PSObject.Properties['statusCacheMs'])) {
        $config.adapter | Add-Member -NotePropertyName statusCacheMs -NotePropertyValue 3000
        $added.Add('adapter.statusCacheMs = 3000  (状态/进程列表缓存合并，防刷新风暴)') | Out-Null
    }

    if (-not ($config.PSObject.Properties['processLog'])) {
        $config | Add-Member -NotePropertyName processLog -NotePropertyValue ([pscustomobject]@{
            mode = 'oracle'
            oracle = [pscustomobject]@{
                user = 'infodba'
                passwordEnv = 'TC_DB_PASSWORD'
                connectString = 'db.example.com:1521/orcl'
            }
            pathPrefixes = [pscustomobject]@{
                PoolA = 'D:\Teamcenter\logs\ServerManagers\PoolA\TcServer\process'
            }
        })
        $added.Add('processLog = {oracle + pathPrefixes}  (按需日志路径查询，需按现场修改)') | Out-Null
    }

    if ($added.Count -gt 0) {
        # Write UTF-8 WITHOUT BOM: Node's JSON.parse rejects a BOM.
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($Path, ($config | ConvertTo-Json -Depth 64), $utf8NoBom)
        Write-Host 'Upgrade: added new configuration fields to the existing config.json:' -ForegroundColor Yellow
        foreach ($field in $added) { Write-Host "  - $field" -ForegroundColor Yellow }
    }
}

$resolvedParent = [System.IO.Path]::GetFullPath((Split-Path -Parent $InstallRoot))
$resolvedInstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
if ($resolvedInstallRoot -eq [System.IO.Path]::GetPathRoot($resolvedInstallRoot)) {
    throw 'InstallRoot cannot be a drive root.'
}

& (Join-Path $PSScriptRoot 'verify-packages.ps1')

$appSource = Join-Path $PSScriptRoot 'app'
$nodeArchive = Join-Path $PSScriptRoot 'packages\node-v24.21.0-win-x64.zip'
if (-not (Test-Path -LiteralPath $appSource)) {
    throw "Missing application directory: $appSource"
}

New-Item -ItemType Directory -Force -Path $resolvedParent | Out-Null
New-Item -ItemType Directory -Force -Path $resolvedInstallRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $resolvedInstallRoot 'app') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $resolvedInstallRoot 'runtime') | Out-Null

# Decide whether an operator-edited config.json exists BEFORE the app copy
# overwrites the app directory with the shipped (pre-filled) one.
$configPath = Join-Path $resolvedInstallRoot 'app\config.json'
$existingConfig = Test-Path -LiteralPath $configPath
Copy-Item -Path (Join-Path $appSource '*') -Destination (Join-Path $resolvedInstallRoot 'app') -Recurse -Force

if ($existingConfig) {
    Write-Host '已保留安装目录里现有的 config.json（未覆盖）。' -ForegroundColor Yellow
    Add-Missing-Config-Fields -Path $configPath
} else {
    Write-Host '已部署示例配置 app\config.json（JMX/Oracle 地址与日志路径前缀均为示例，请按现场修改）。' -ForegroundColor Yellow
    Write-Host 'Oracle 密码不在此文件里，通过环境变量 TC_DB_PASSWORD 注入。' -ForegroundColor Yellow
}

$nodeExecutable = Join-Path $resolvedInstallRoot 'runtime\node-v24.21.0-win-x64\node.exe'
if (-not (Test-Path -LiteralPath $nodeExecutable)) {
    Expand-Archive -LiteralPath $nodeArchive -DestinationPath (Join-Path $resolvedInstallRoot 'runtime') -Force
}

Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'start-demo.cmd') -Destination $resolvedInstallRoot -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'start-production.cmd') -Destination $resolvedInstallRoot -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'stop.cmd') -Destination $resolvedInstallRoot -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'stop-mgmt-console-lite.ps1') -Destination $resolvedInstallRoot -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install.cmd') -Destination $resolvedInstallRoot -Force

# Java check: the JMX bridge spawns a JVM for every Server Manager call.
$javaOk = $false
try {
    $javaVersionOutput = & cmd /c 'java -version' 2>&1 | Select-Object -First 1
    if ($LASTEXITCODE -eq 0) { $javaOk = $true; Write-Host "Java detected: $javaVersionOutput" }
} catch { }
if (-not $javaOk -and $env:TC_JAVA_HOME -and (Test-Path (Join-Path $env:TC_JAVA_HOME 'bin\java.exe'))) {
    $javaOk = $true; Write-Host "Java detected via TC_JAVA_HOME: $env:TC_JAVA_HOME"
}
if (-not $javaOk) {
    Write-Warning '未检测到可用的 java（需要 JDK/JRE 11 或更高版本）。JMX 桥无法运行。'
    Write-Warning '请安装 JDK 11+，或设置系统环境变量 TC_JAVA_HOME 指向 JDK 根目录后重新打开窗口。'
}

Write-Host ''
Write-Host 'Running self-tests with the bundled Node runtime...'
& $nodeExecutable --test `
    (Join-Path $resolvedInstallRoot 'app\test\config.test.js') `
    (Join-Path $resolvedInstallRoot 'app\test\session.test.js') `
    (Join-Path $resolvedInstallRoot 'app\test\process-logs.test.js') `
    (Join-Path $resolvedInstallRoot 'app\test\jmx-chain.test.js') `
    (Join-Path $resolvedInstallRoot 'app\test\http.test.js') `
    (Join-Path $resolvedInstallRoot 'app\test\login-command.test.js')

# Sanity check the vendored Oracle driver (thin mode, no Oracle client needed).
Push-Location (Join-Path $resolvedInstallRoot 'app')
& $nodeExecutable -e "import('oracledb').then(() => console.log('oracledb module OK (thin mode)')).catch((error) => { console.error('oracledb module missing: ' + error.message); process.exit(1); })"
Pop-Location

Write-Host ''
Write-Host 'Offline installation completed.' -ForegroundColor Green
Write-Host "Install root: $resolvedInstallRoot"
Write-Host 'Next: set TC_DB_PASSWORD (Oracle infodba password), then run start-production.cmd. Use stop.cmd to stop it.'
