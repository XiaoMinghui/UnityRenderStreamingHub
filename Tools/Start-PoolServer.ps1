[CmdletBinding()]
param([ValidateRange(1,65535)][int]$Port = 8080)
$ErrorActionPreference = 'Stop'
if (-not $env:RENDERSTREAMING_POOL_TOKEN) { throw 'Set RENDERSTREAMING_POOL_TOKEN before starting the instance pool.' }
$taskWebApp = Join-Path (Split-Path -Parent $PSScriptRoot) 'WebApp'
Push-Location -LiteralPath $taskWebApp
try {
    if (-not (Test-Path 'node_modules/typescript/bin/tsc')) {
        & npm.cmd ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Server build failed.' }
    Write-Host "Instance pool receiver: http://localhost:$Port/pool/index.html"
    & node build/index.js -p $Port -t websocket -m public --pool
    if ($LASTEXITCODE -ne 0) { throw 'Server exited with an error.' }
} finally { Pop-Location }
