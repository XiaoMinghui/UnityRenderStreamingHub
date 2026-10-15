[CmdletBinding()]
param([ValidateRange(1,65535)][int]$Port = 8080)
$ErrorActionPreference = 'Stop'
$taskWebApp = Join-Path (Split-Path -Parent $PSScriptRoot) 'WebApp'
if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw 'Install Node.js 22 LTS (including npm), then reopen this launcher.'
}
Push-Location -LiteralPath $taskWebApp
try {
    if (-not (Test-Path 'node_modules/typescript/bin/tsc')) {
        & npm.cmd ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Server build failed.' }
    Write-Host "Receiver: http://localhost:$Port/receiver/index.html (use this PC's LAN address on the receiving device)"
    & node build/index.js -p $Port -t websocket -m public
    if ($LASTEXITCODE -ne 0) { throw 'Server exited with an error. Check whether the port is in use.' }
} finally { Pop-Location }
