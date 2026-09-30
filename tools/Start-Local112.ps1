# Start the local Dauntless 1.12.0 stack: the metagame, the deploy server and
# its initial world servers, then optionally a client.
#
# Ports come from the packages' .env files; paths from tools/Local112Config.ps1
# (parameters, environment variables or tools/local112.json). Anything already
# running is left alone. Logs go to <dataRoot>\logs.
#
#   powershell -File tools\Start-Local112.ps1                  # servers, then the default account's client
#   powershell -File tools\Start-Local112.ps1 -ServerOnly      # servers only
#   powershell -File tools\Start-Local112.ps1 -Account <Name>  # servers, then that account's client
param(
    [switch]$ServerOnly,
    [string]$Account,
    [string]$DataRoot,
    [string]$GameDirectory
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Local112Config.ps1')
$config = Resolve-Local112Config -DataRoot $DataRoot -GameDirectory $GameDirectory -RequireDataRoot
$ports = Get-Local112Ports $config
$node = (Get-Command node.exe).Source
$logDir = Join-Path $config.DataRoot 'logs'

foreach ($dir in $config.Metagame, $config.DeployServer) {
    if (-not (Test-Path (Join-Path $dir '.env'))) { throw "$dir\.env is missing (start from .env.example)." }
    if (-not (Test-Path (Join-Path $dir 'dist\server.js'))) { throw "$dir is not built (npm run build, or tools\Build-Local112.ps1 -Deploy)." }
}
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

function Wait-TcpPort([int]$Port, [int]$TimeoutSeconds = 20) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { return }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    throw "Local TCP port $Port did not open. Check $logDir."
}

# The deploy server starts Ramsgate and the Training Grounds on boot, each on
# whichever port it takes from its range, so wait for two worlds in that range.
function Wait-Worlds([int]$Count = 2, [int]$TimeoutSeconds = 90) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $open = @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalPort -ge $ports.WorldFirst -and $_.LocalPort -le $ports.WorldLast } |
            Select-Object -ExpandProperty LocalPort -Unique)
        if ($open.Count -ge $Count) { return $open }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw "World servers did not open on UDP $($ports.WorldFirst)-$($ports.WorldLast). Check the deploy server's GAMESERVER_LOG_DIR."
}

# Keep the previous run's log instead of overwriting it.
function Start-Service112([string]$Dir, [string]$Name, [int]$Port) {
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
        Write-Output "1.12 $Name already running on $Port."
        return
    }
    $log = Join-Path $logDir "$Name-1.12.log"
    if (Test-Path $log) { Move-Item $log (Join-Path $logDir ("$Name-1.12-{0:yyyyMMdd-HHmmss}.log" -f (Get-Date))) -Force }
    Start-Process -FilePath $node -ArgumentList '--env-file=.env', 'dist/server.js' -WorkingDirectory $Dir `
        -WindowStyle Hidden -RedirectStandardOutput $log `
        -RedirectStandardError (Join-Path $logDir "$Name-1.12.err.log") | Out-Null
    Wait-TcpPort $Port
    Write-Output "1.12 $Name started on $Port."
}

Start-Service112 $config.Metagame 'metagame' $ports.Metagame
Wait-TcpPort $ports.Xmpp
Start-Service112 $config.DeployServer 'deploy' $ports.Deploy
$worlds = Wait-Worlds
Write-Output "1.12 worlds listening on UDP $($worlds -join ', ')."

if ($ServerOnly) { exit 0 }
if (-not $Account) { $Account = $config.DefaultAccount }
if (-not $Account) {
    Write-Output 'No account given and no defaultAccount configured; not launching a client.'
    exit 0
}

# A world server runs the same executable, hidden; the client is the one with a window.
$config = Resolve-Local112Config -DataRoot $config.DataRoot -GameDirectory $GameDirectory -RequireGameDirectory
$gamePath = Join-Path $config.GameDirectory 'Dauntless-Win64-Shipping.exe'
$client = Get-Process -Name 'Dauntless-Win64-Shipping' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $gamePath -and $_.MainWindowHandle -ne [IntPtr]::Zero }
if ($client) {
    Write-Output "Dauntless 1.12.0 client is already running (PID $($client[0].Id))."
    exit 0
}

& (Join-Path $PSScriptRoot 'Launch-Local112.ps1') -Account $Account -DataRoot $config.DataRoot -GameDirectory $config.GameDirectory
