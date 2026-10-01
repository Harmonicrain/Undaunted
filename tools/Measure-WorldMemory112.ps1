# Observe a world during manual join/leave cycles. Never drives the game,
# changes the database, trims memory, or prints account keys/command lines.
param(
    [int]$WorldPort,
    [ValidateRange(5,86400)][int]$DurationSeconds = 1800,
    [ValidateRange(1,60)][int]$IntervalSeconds = 5,
    [string]$OutputCsv,
    [string]$DataRoot,
    [string]$GameDirectory
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Local112Config.ps1')
$config = Resolve-Local112Config -DataRoot $DataRoot -GameDirectory $GameDirectory -RequireGameDirectory
$ports = Get-Local112Ports $config
if (-not $WorldPort) { $WorldPort = $ports.WorldLast }
if ($WorldPort -lt $ports.WorldFirst -or $WorldPort -gt $ports.WorldLast) { throw 'WorldPort is outside the configured 1.12 range.' }
if (-not $OutputCsv) {
    $folder = Join-Path $config.Repo 'artifacts'
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
    $OutputCsv = Join-Path $folder ('world-memory-{0}-{1:yyyyMMdd-HHmmss}.csv' -f $WorldPort,(Get-Date))
}
if (Test-Path -LiteralPath $OutputCsv) { throw 'OutputCsv already exists; choose a new file.' }
$log = Join-Path $config.GameDirectory "mysticparadox_dll_port$WorldPort.log"
$deadline = [DateTime]::UtcNow.AddSeconds($DurationSeconds)
$lastPid = 0; $lastCpu = 0.0; $lastTime = [DateTime]::UtcNow
$lastConnections = -1; $cycles = 0; $sawPlayer = $false
do {
    $endpoint = Get-NetUDPEndpoint -LocalPort $WorldPort -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $endpoint) { Write-Output "World port $WorldPort is asleep or stopped."; break }
    $process = Get-Process -Id $endpoint.OwningProcess -ErrorAction SilentlyContinue
    if (-not $process) { Start-Sleep -Seconds $IntervalSeconds; continue }
    $expectedExe = Join-Path $config.GameDirectory 'Dauntless-Win64-Shipping.exe'
    if ($process.Path -ne $expectedExe) { throw 'Port owner is not the configured 1.12 world executable.' }
    if ($process.Id -ne $lastPid) { $lastConnections = -1; $sawPlayer = $false }
    $connections = -1; $objects = -1
    if (Test-Path -LiteralPath $log) {
        foreach ($line in Get-Content -LiteralPath $log -Tail 1500) {
            if ($line -notmatch ('pid=' + $process.Id + ' ')) { continue }
            if ($line -match '\[NetConnEdge\].* -> (-?\d+) connMax=') { $connections = [int]$Matches[1] }
            if ($line -match '\[(Perf|Memory)\].*connections (-?\d+)') { $connections = [int]$Matches[2] }
            if ($line -match '\[Memory\].*objects (-?\d+)') { $objects = [int]$Matches[1] }
        }
    }
    if ($connections -gt 0) { $sawPlayer = $true }
    if ($connections -eq 0 -and $lastConnections -gt 0 -and $sawPlayer) { $cycles++; $sawPlayer = $false }
    $now = [DateTime]::UtcNow
    $cpu = $null
    if ($process.Id -eq $lastPid -and ($now-$lastTime).TotalSeconds -gt 0) {
        $cpu = [math]::Round(100*($process.TotalProcessorTime.TotalSeconds-$lastCpu)/($now-$lastTime).TotalSeconds,2)
    }
    $row = [pscustomobject]@{
        utc=$now.ToString('o'); port=$WorldPort; pid=$process.Id; connections=$connections
        completedJoinLeaveCycles=$cycles; workingSetMiB=[math]::Round($process.WorkingSet64/1MB,2)
        privateCommitMiB=[math]::Round($process.PrivateMemorySize64/1MB,2)
        cpuPercentOfOneCore=$cpu; lastLoggedObjectCount=$objects
    }
    $row | Export-Csv -LiteralPath $OutputCsv -Append -NoTypeInformation
    Write-Output ("world {0}: connections {1}, resident {2} MiB, commit {3} MiB, cycles {4}" -f $WorldPort,$connections,$row.workingSetMiB,$row.privateCommitMiB,$cycles)
    $lastPid=$process.Id; $lastCpu=$process.TotalProcessorTime.TotalSeconds; $lastTime=$now; $lastConnections=$connections
    $remaining = ($deadline-[DateTime]::UtcNow).TotalMilliseconds
    if ($remaining -gt 0) { Start-Sleep -Milliseconds ([int][math]::Min($IntervalSeconds*1000,$remaining)) }
} while ([DateTime]::UtcNow -lt $deadline)
Write-Output "Completed join/leave cycles observed: $cycles. CSV: $OutputCsv"
