$ErrorActionPreference = 'Stop'
$packageDirectory = Join-Path $PSScriptRoot 'packages'
$checksumFile = Join-Path $packageDirectory 'SHASUMS256.txt'
$nodeArchive = Join-Path $packageDirectory 'node-v24.21.0-win-x64.zip'

if (-not (Test-Path -LiteralPath $checksumFile)) {
    throw "Missing checksum file: $checksumFile"
}
if (-not (Test-Path -LiteralPath $nodeArchive)) {
    throw "Missing Node.js archive: $nodeArchive"
}

$expectedLine = Get-Content -LiteralPath $checksumFile |
    Where-Object { $_ -match 'node-v24\.21\.0-win-x64\.zip$' } |
    Select-Object -First 1
if (-not $expectedLine) {
    throw 'Node.js archive was not found in SHASUMS256.txt.'
}

$expected = ($expectedLine -split '\s+')[0].ToLowerInvariant()
$actual = (Get-FileHash -LiteralPath $nodeArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) {
    throw "SHA256 mismatch. Expected $expected but received $actual."
}

Write-Host 'Offline package verification passed.' -ForegroundColor Green
Write-Host "Node.js SHA256: $actual"
