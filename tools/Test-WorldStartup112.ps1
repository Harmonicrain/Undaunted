# After a restart, checks every running 1.12 world server's runtime log: it
# loaded the build just deployed, finished listening, and installed every hook
# and instruction patch. Reads logs only and prints no command lines.
#   powershell -NoProfile -File tools/Test-WorldStartup112.ps1 -GameDirectory <dir> -BuildId <id>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$GameDirectory,
    [Parameter(Mandatory = $true)][string]$BuildId,
    [int]$TimeoutSeconds = 90
)
$ErrorActionPreference = 'Stop'
$client = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'client112.json') -Raw | ConvertFrom-Json
$logDirectory = Split-Path -Parent (Join-Path $GameDirectory $client.executable)
$processName = [IO.Path]::GetFileNameWithoutExtension($client.executable)

# The last 8 MB of a log: worlds append to the same file per port.
function Read-LogTail([string]$Path) {
    $stream = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
    try {
        $length = [Math]::Min($stream.Length, 8MB)
        $null = $stream.Seek(-$length, 'End')
        $buffer = New-Object byte[] $length
        $read = $stream.Read($buffer, 0, $length)
        return [Text.Encoding]::UTF8.GetString($buffer, 0, $read) -split "`r?`n"
    } finally { $stream.Dispose() }
}

# World servers: windowless game processes that own a UDP port.
$worlds = @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue | ForEach-Object {
    $process = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
    if ($process -and $process.ProcessName -eq $processName -and $process.MainWindowHandle -eq 0) {
        [pscustomobject]@{ Port = $_.LocalPort; Pid = $_.OwningProcess }
    }
} | Sort-Object Port -Unique)
if (-not $worlds.Count) { throw 'No world servers are running.' }

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$failures = @()
foreach ($world in $worlds) {
    $log = Join-Path $logDirectory "mysticparadox_dll_port$($world.Port).log"
    $tag = "pid=$($world.Pid) "
    while ($true) {
        $lines = if (Test-Path -LiteralPath $log) { @(Read-LogTail $log | Where-Object { $_.Contains($tag) }) } else { @() }
        $listening = @($lines | Where-Object { $_.Contains('[Networking::Listen] Complete') }).Count -gt 0
        if ($listening -or (Get-Date) -gt $deadline) { break }
        Start-Sleep -Seconds 2
    }
    $problems = @()
    if (-not @($lines | Where-Object { $_.Contains("[Build] id=$BuildId mode=server") }).Count) { $problems += "not running build $BuildId" }
    if (-not $listening) { $problems += 'never finished listening' }
    $problems += @($lines | Where-Object { $_ -match '\[Hooks\] .* FAILED|\[CodePatch\] .* not patched' } |
        ForEach-Object { ($_ -replace '^.*?(\[(Hooks|CodePatch)\])', '$1').Trim() })
    if ($problems.Count) {
        $failures += "UDP $($world.Port) (pid $($world.Pid)): " + ($problems -join '; ')
    } else {
        Write-Output "UDP $($world.Port): build $BuildId, listening, all hooks and patches in place."
    }
}
if ($failures.Count) {
    $failures | Write-Output
    throw "$($failures.Count) world server(s) failed the startup check."
}
