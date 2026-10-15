[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectPath,

    [ValidateSet('Local', 'Git')]
    [string]$Mode = 'Local',

    [string]$SourcePath = (Split-Path -Parent $PSScriptRoot),

    [string]$Revision = 'main'
)

$ErrorActionPreference = 'Stop'
$taskProject = (Resolve-Path -LiteralPath $ProjectPath).Path
$taskManifestPath = Join-Path $taskProject 'Packages/manifest.json'
if (-not (Test-Path -LiteralPath $taskManifestPath -PathType Leaf)) {
    throw "Unity project manifest not found: $taskManifestPath"
}

$taskManifestText = [IO.File]::ReadAllText($taskManifestPath)
$taskManifest = $taskManifestText | ConvertFrom-Json
if ($null -eq $taskManifest.dependencies) {
    throw 'The manifest must contain a dependencies object.'
}

if ($Mode -eq 'Local') {
    $taskSource = (Resolve-Path -LiteralPath $SourcePath).Path
    $taskPackage = Join-Path $taskSource 'com.unity.renderstreaming'
    $taskPackageManifest = Join-Path $taskPackage 'package.json'
    if (-not (Test-Path -LiteralPath $taskPackageManifest -PathType Leaf)) {
        throw "Shared Render Streaming package not found: $taskPackageManifest"
    }
    $taskPackageInfo = [IO.File]::ReadAllText($taskPackageManifest) | ConvertFrom-Json
    if ($taskPackageInfo.name -ne 'com.unity.renderstreaming') {
        throw 'The source package has an unexpected name.'
    }
    $taskPackagesUri = [Uri]((Join-Path $taskProject 'Packages') + [IO.Path]::DirectorySeparatorChar)
    $taskPackageUri = [Uri]($taskPackage + [IO.Path]::DirectorySeparatorChar)
    $taskRelative = [Uri]::UnescapeDataString($taskPackagesUri.MakeRelativeUri($taskPackageUri).ToString()).TrimEnd('/')
    if ($taskRelative -match '^[a-zA-Z]+:') {
        # Different Windows drive: use an absolute local package path.
        $taskRelative = $taskPackage.Replace('\', '/')
    }
    $taskDependency = 'file:' + $taskRelative
}
else {
    if ([string]::IsNullOrWhiteSpace($Revision) -or $Revision -match '[\s?#]') {
        throw 'Revision must be a Git branch, tag or commit SHA without whitespace, ? or #.'
    }
    $taskDependency = 'https://github.com/XiaoMinghui/UnityRenderStreamingHub.git?path=/com.unity.renderstreaming#' + $Revision
}

$taskProperty = $taskManifest.dependencies.PSObject.Properties['com.unity.renderstreaming']
if ($null -ne $taskProperty -and $taskProperty.Value -eq $taskDependency) {
    Write-Output "Already configured: $taskDependency"
    return
}

$taskEncodedDependency = $taskDependency | ConvertTo-Json -Compress
if ($null -ne $taskProperty) {
    $taskPattern = '("com\.unity\.renderstreaming"\s*:\s*)"(?:\\.|[^"\\])*"'
    $taskNewManifest = [regex]::Replace($taskManifestText, $taskPattern, {
        param($taskMatch)
        $taskMatch.Groups[1].Value + $taskEncodedDependency
    })
}
else {
    $taskNewline = if ($taskManifestText.Contains("`r`n")) { "`r`n" } else { "`n" }
    $taskComma = if (@($taskManifest.dependencies.PSObject.Properties).Count -gt 0) { ',' } else { '' }
    $taskEntry = $taskNewline + '    "com.unity.renderstreaming": ' + $taskEncodedDependency + $taskComma
    $taskNewManifest = [regex]::Replace($taskManifestText, '"dependencies"\s*:\s*\{', {
        param($taskMatch)
        $taskMatch.Value + $taskEntry
    })
}

# Parse the proposed result before writing a backup or changing the project.
$taskValidatedManifest = $taskNewManifest | ConvertFrom-Json
if ($taskValidatedManifest.dependencies.'com.unity.renderstreaming' -ne $taskDependency) {
    throw 'The proposed manifest did not contain the expected dependency.'
}

if ($PSCmdlet.ShouldProcess($taskManifestPath, "Use shared Render Streaming package: $taskDependency")) {
    $taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $taskBackup = Join-Path $taskProject ('Backups/SharedRenderStreaming/' + $taskStamp)
    New-Item -ItemType Directory -Path $taskBackup -Force | Out-Null
    Copy-Item -LiteralPath $taskManifestPath -Destination (Join-Path $taskBackup 'manifest.json')
    $taskLockPath = Join-Path $taskProject 'Packages/packages-lock.json'
    if (Test-Path -LiteralPath $taskLockPath -PathType Leaf) {
        Copy-Item -LiteralPath $taskLockPath -Destination (Join-Path $taskBackup 'packages-lock.json')
    }
    [IO.File]::WriteAllText($taskManifestPath, $taskNewManifest, [Text.UTF8Encoding]::new($false))
    Write-Output "Configured: $taskDependency"
    Write-Output "Backup: $taskBackup"
    Write-Output 'Refresh or reopen the Unity project so Package Manager resolves the dependency and updates its lock file.'
}
