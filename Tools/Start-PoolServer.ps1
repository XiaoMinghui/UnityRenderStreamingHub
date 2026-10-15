[CmdletBinding()]
param([ValidateRange(1,65535)][int]$Port = 8080, [switch]$Admin, [switch]$Agents,
    [ValidateRange(0,300)][int]$ResumeGraceSeconds = 30)
$ErrorActionPreference = 'Stop'
if ($Agents) { $Admin = $true }
if (-not $env:RENDERSTREAMING_POOL_TOKEN) { throw 'Set RENDERSTREAMING_POOL_TOKEN before starting the instance pool.' }
if ($Admin -and (-not $env:RENDERSTREAMING_ADMIN_TOKEN -or $env:RENDERSTREAMING_ADMIN_TOKEN -eq $env:RENDERSTREAMING_POOL_TOKEN)) { throw 'Set a separate RENDERSTREAMING_ADMIN_TOKEN before enabling management.' }
if ($Agents -and (-not $env:RENDERSTREAMING_AGENT_TOKEN -or $env:RENDERSTREAMING_AGENT_TOKEN -eq $env:RENDERSTREAMING_POOL_TOKEN -or $env:RENDERSTREAMING_AGENT_TOKEN -eq $env:RENDERSTREAMING_ADMIN_TOKEN)) { throw 'Set a separate RENDERSTREAMING_AGENT_TOKEN before enabling process agents.' }
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
    $serverArguments = @('build/index.js', '-p', $Port, '-t', 'websocket', '-m', 'public', '--pool', '--pool-resume-seconds', $ResumeGraceSeconds)
    if ($Admin) { $serverArguments += '--admin'; Write-Host "Management dashboard: http://localhost:$Port/admin/" }
    if ($Agents) { $serverArguments += '--agents' }
    & node @serverArguments
    if ($LASTEXITCODE -ne 0) { throw 'Server exited with an error.' }
} finally { Pop-Location }
