# Launch the Dauntless 1.12.0 client against the local 1.12 metagame.
#
# Reads <dataRoot>\data\account-1.12-<Account>.json (written by
# New-Account112.mjs). The account's key is passed to the game as its exchange
# code and never printed.
#
#   powershell -File tools\Launch-Local112.ps1 -Account <Name> [-Log] [-LogCmds "..."]
param(
    [string]$Account,
    [switch]$Log,
    [string]$LogCmds,
    [string]$DataRoot,
    [string]$GameDirectory
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Local112Config.ps1')
$config = Resolve-Local112Config -DataRoot $DataRoot -GameDirectory $GameDirectory -RequireDataRoot -RequireGameDirectory
if (-not $Account) { $Account = $config.DefaultAccount }
if (-not $Account) { throw 'Name the account to launch with -Account, or set defaultAccount in tools\local112.json.' }
if ($Account -notmatch '^[A-Za-z0-9_-]{3,16}$') { throw "Invalid account name: $Account" }

$exe = Join-Path $config.GameDirectory 'Dauntless-Win64-Shipping.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "Dauntless 1.12.0 executable not found: $exe" }
$accountFile = Join-Path $config.DataRoot "data\account-1.12-$Account.json"
if (-not (Test-Path -LiteralPath $accountFile)) { throw "No account file for $Account (run tools\New-Account112.mjs)." }
$acct = Get-Content -LiteralPath $accountFile -Raw | ConvertFrom-Json
if (-not ($acct.UUK -match '^UUK_[0-9a-f]{48}$')) { throw 'Account key is missing or invalid.' }
$status = Invoke-RestMethod -Uri "http://$($acct.Backend)/dauntless-status" -TimeoutSec 3
if (-not $status.'show-status') { throw '1.12 metagame is not ready.' }

# The Epic identifiers are the fixed values the 1.12.0 client expects on its
# command line; they are not credentials.
$gameArgs = @(
    '-EpicPortal', '-NoEAC', '-AUTH_TYPE=exchangecode',
    "-AUTH_LOGIN=$($acct.UserId)", "-AUTH_PASSWORD=$($acct.UUK)",
    '-epicapp=Archon', '-epicenv=Prod', "-epicusername=$($acct.Username)",
    "-epicuserid=$($acct.UserId)", "-epicaccountid=$($acct.UserId)",
    '-epicsandboxid=jackal', '-epicdeploymentid=53565ba467df4edbb6f5a3d939a8b4f2',
    "-UndauntedMetagame=$($acct.Backend)",
    '-windowed', '-ResX=1280', '-ResY=720'
)
if ($Log) { $gameArgs += '-log' }
if ($LogCmds) { $gameArgs += "-LogCmds=`"$LogCmds`"" }
$game = Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe) -ArgumentList $gameArgs -PassThru
Write-Output "Started Dauntless 1.12.0 as $($acct.Username) against $($acct.Backend) (PID $($game.Id))."
