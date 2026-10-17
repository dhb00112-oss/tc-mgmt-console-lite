# Stops the mgmt-console-lite node process identified by the PID file.
# Never kills node.exe processes blindly: the PID is validated to be a node
# process owned by the current user before Stop-Process is called.
param(
  [Parameter(Mandatory = $true)]
  [string]$PidFile
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $PidFile)) {
  Write-Output "PID file not found: $PidFile (the program is probably not running)."
  exit 0
}

$pidText = (Get-Content -Path $PidFile -Raw).Trim()
$targetPid = 0
if (-not [int]::TryParse($pidText, [ref]$targetPid)) {
  Write-Output "PID file contains an invalid value: $pidText"
  exit 1
}

$process = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
if (-not $process) {
  Write-Output "Process $targetPid is not running. Removing stale PID file."
  Remove-Item -Path $PidFile -Force
  exit 0
}

if ($process.ProcessName -ne 'node') {
  Write-Output "Refusing to stop process $targetPid ('$($process.ProcessName)') because it is not node.exe."
  exit 1
}

$owner = $null
try {
  $owner = (Get-CimInstance Win32_Process -Filter "ProcessId = $targetPid").GetOwner().User
} catch {
  $owner = $null
}
if ($owner -and $owner -ne $env:USERNAME) {
  Write-Output "Refusing to stop process $targetPid owned by another user ($owner)."
  exit 1
}

Stop-Process -Id $targetPid -Force
Start-Sleep -Milliseconds 300
if (Get-Process -Id $targetPid -ErrorAction SilentlyContinue) {
  Write-Output "Process $targetPid did not exit."
  exit 1
}
Remove-Item -Path $PidFile -Force -ErrorAction SilentlyContinue
Write-Output "Stopped mgmt-console-lite (PID $targetPid)."
exit 0
