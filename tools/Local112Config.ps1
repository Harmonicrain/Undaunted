# Local settings shared by the 1.12 scripts. Nothing machine-specific lives in
# the repository: each path comes from a parameter, then an environment
# variable, then tools/local112.json (ignored by git; start from
# tools/local112.example.json).
#
#   dataRoot       holds data/ (databases, account files) and logs/
#   gameDirectory  the 1.12.0 client's Archon\Binaries\Win64 folder
#   defaultAccount optional; the account Start-Local112.ps1 launches a client for
#
# Dot-source this file, then call Resolve-Local112Config.
$Local112ToolsDirectory = $PSScriptRoot

function Resolve-Local112Config {
    param(
        [string]$DataRoot,
        [string]$GameDirectory,
        [switch]$RequireDataRoot,
        [switch]$RequireGameDirectory
    )
    $file = Join-Path $Local112ToolsDirectory 'local112.json'
    $config = $null
    if (Test-Path -LiteralPath $file) { $config = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json }

    if (-not $DataRoot) { $DataRoot = $env:UNDAUNTED112_DATA_ROOT }
    if (-not $DataRoot -and $config) { $DataRoot = $config.dataRoot }
    if (-not $GameDirectory) { $GameDirectory = $env:UNDAUNTED112_GAME_DIR }
    if (-not $GameDirectory -and $config) { $GameDirectory = $config.gameDirectory }
    $defaultAccount = $env:UNDAUNTED112_ACCOUNT
    if (-not $defaultAccount -and $config) { $defaultAccount = $config.defaultAccount }

    $hint = 'Pass it as a parameter, set {0}, or copy tools\local112.example.json to tools\local112.json.'
    if ($RequireDataRoot -and -not $DataRoot) {
        throw ('The local data root is not configured. ' + ($hint -f 'UNDAUNTED112_DATA_ROOT'))
    }
    if ($RequireGameDirectory -and -not $GameDirectory) {
        throw ('The 1.12.0 game directory is not configured. ' + ($hint -f 'UNDAUNTED112_GAME_DIR'))
    }

    $repo = [IO.Path]::GetFullPath((Split-Path -Parent $Local112ToolsDirectory))
    $resolvedData = $null
    if ($DataRoot) { $resolvedData = [IO.Path]::GetFullPath($DataRoot) }
    $resolvedGame = $null
    if ($GameDirectory) { $resolvedGame = [IO.Path]::GetFullPath($GameDirectory) }
    [pscustomobject]@{
        Repo           = $repo
        Metagame       = Join-Path $repo 'UndauntedMetagame'
        DeployServer   = Join-Path $repo 'UndauntedDeployServer'
        DataRoot       = $resolvedData
        GameDirectory  = $resolvedGame
        DefaultAccount = $defaultAccount
    }
}

# KEY=value lines of a .env file; comments and blank lines are skipped.
function Read-DotEnv([string]$Path) {
    $values = @{}
    if (-not (Test-Path -LiteralPath $Path)) { return $values }
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match '^\s*([A-Za-z0-9_]+)\s*=(.*)$') { $values[$Matches[1]] = $Matches[2].Trim() }
    }
    return $values
}

# The ports the configured stack listens on, from the packages' .env files.
function Get-Local112Ports($Config) {
    $metagame = Read-DotEnv (Join-Path $Config.Metagame '.env')
    $deploy = Read-DotEnv (Join-Path $Config.DeployServer '.env')
    function Port($Values, [string]$Name, [int]$Default) {
        if ($Values.ContainsKey($Name) -and $Values[$Name] -match '^\d+$') { return [int]$Values[$Name] }
        return $Default
    }
    [pscustomobject]@{
        Metagame   = Port $metagame 'PORT' 61000
        Xmpp       = Port $metagame 'XMPP_PORT' 60002
        Deploy     = Port $deploy 'PORT' 61001
        WorldFirst = Port $deploy 'PORT_RANGE_BEGIN' 8780
        WorldLast  = Port $deploy 'PORT_RANGE_END' 8789
    }
}
