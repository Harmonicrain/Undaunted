$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'WorldMemoryLog112.ps1')
$legacy = Get-WorldMemoryLogCounters112 -WorldProcessId 123 -Lines @(
    'pid=123 [Memory] connections 1, working set 80 MiB, private commit 600 MiB, objects 100',
    'pid=123 [NetConnEdge] tick=42 connCount 1 -> 0 connMax=4',
    'pid=456 [Memory] connections 4, objects 900'
)
if ($legacy.Connections -ne 0 -or $legacy.ObjectSlots -ne 100 -or $legacy.RegisteredObjects -ne -1) {
    throw 'Legacy slots, connection edges or process filtering failed.'
}
$profile = Get-WorldMemoryLogCounters112 -WorldProcessId 123 -Lines @(
    'pid=123 [Memory] connections 0, working set 80 MiB, private commit 600 MiB, object slots 100',
    'pid=123 [ObjectProfile] 100 slots, 75 registered objects in 12 classes (includes defaults and pending GC)',
    'pid=123 [ObjectProfile] 30 registered  Function',
    'pid=123 [ObjectProfile] 100 slots, 65 registered objects in 10 classes (includes defaults and pending GC)',
    'pid=1234 [ObjectProfile] 900 slots, 850 registered objects in 12 classes'
)
if ($profile.Connections -ne 0 -or $profile.ObjectSlots -ne 100 -or $profile.RegisteredObjects -ne 65) {
    throw 'The registered object count must decrease independently of slot count.'
}
$unknown = Get-WorldMemoryLogCounters112 -WorldProcessId 456 -Lines @('pid=123 [ObjectProfile] 100 slots, 65 registered objects')
if ($unknown.ObjectSlots -ne -1 -or $unknown.RegisteredObjects -ne -1) { throw 'A new process must not inherit stale counters.' }
Write-Output 'World memory log checks passed: legacy/current formats, freed slots and process isolation.'
