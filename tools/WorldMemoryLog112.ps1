# Parse only counters from the selected world's log. Array slots include holes;
# registered objects are available only from an enabled script profile.
function Get-WorldMemoryLogCounters112 {
    param([string[]]$Lines, [int]$WorldProcessId)
    $connections = -1; $slots = -1; $registered = -1
    foreach ($line in $Lines) {
        if ($line -notmatch ('pid=' + $WorldProcessId + ' ')) { continue }
        if ($line -match '\[NetConnEdge\].* -> (-?\d+) connMax=') { $connections = [int]$Matches[1] }
        if ($line -match '\[(Perf|Memory)\].*connections (-?\d+)') { $connections = [int]$Matches[2] }
        if ($line -match '\[Memory\].*(?:object slots|objects) (-?\d+)') { $slots = [int]$Matches[1] }
        if ($line -match '\[ObjectProfile\] (\d+) slots, (\d+) registered objects') {
            $slots = [int]$Matches[1]; $registered = [int]$Matches[2]
        }
    }
    [pscustomobject]@{ Connections = $connections; ObjectSlots = $slots; RegisteredObjects = $registered }
}
