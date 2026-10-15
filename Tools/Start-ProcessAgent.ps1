[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$resolvedConfig = (Resolve-Path -LiteralPath $ConfigPath).Path
& node (Join-Path $PSScriptRoot 'ProcessAgent/agent.cjs') --config $resolvedConfig
if ($LASTEXITCODE -ne 0) { throw 'Process agent exited with an error. Check config and local logs.' }
