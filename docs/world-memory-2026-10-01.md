# On-demand Training Grounds and memory observations

Training Grounds is no longer launched at deploy startup. Its first matchmaking
request launches it and waits for UDP readiness; concurrent requests share the
same launch. Ramsgate remains ready at boot. Training exits after five minutes
with zero connections and starts again on the next request. Unknown connection
counts reset that grace period rather than being treated as empty.

Every travel request renews a two-minute reservation in a small, PID-specific
`undaunted-training-<pid>.lease` file next to the world executable. The native
game thread takes an exclusive Windows handle before an idle exit. That
serializes the shutdown decision with reservation renewal: a request arriving
during shutdown waits for the old process to exit and receives a replacement.
The native sleeping marker and exit code 75 both distinguish sleep from a
crash, including when the deploy watchdog observes death before the exit event.
Unexpected exits still use crash recovery. Lease files contain only a deadline
or the word `sleeping`, never player identifiers or credentials.

Both the deploy service and the world runtime must be updated together. The
startup script waits specifically for Ramsgate; it no longer expects two worlds.
The first Training Grounds visit therefore includes a world startup delay.

## Checking retained memory

Worlds now log `[Memory]` alongside their minute-level `[Perf]` entries:
connection count, total working set, private committed memory and object-array
slots. Slots include holes left by destroyed objects; they are not a live-object
count.
These are observations, not an additional trimming mechanism.

Run from the repository while manually joining and leaving Ramsgate:

```powershell
powershell -NoProfile -File tools/Measure-WorldMemory112.ps1 -DurationSeconds 1800
```

The observer uses the configured paths and ports, verifies the port owner's
executable, and writes only a CSV under ignored `artifacts/`. It never drives
the game, edits accounts or changes the world's memory. Slot and connection
counts come from the latest relevant log entries; very brief joins between
samples can be missed. Resident memory includes shared pages and must not be
confused with private working set.

Use at least three join/leave cycles with the same character and loadout. Wait
two or three minutes after each leave so idle trimming and garbage collection
have time to settle. Repeat with different cosmetics separately: retained new
assets can be normal caching. Compare settled private commit and registered-object counts;
a growing working set alone is not evidence of a leak. No leak is established
until repeated cycles have actually been observed.

The CSV records `lastLoggedObjectSlots` and `lastLoggedRegisteredObjects`.
Registered counts require a world started with `-UndauntedScriptProfile=<n>`;
otherwise the value is -1 (unknown). `[ObjectProfile]` counts occupied, registered
slots, including class defaults and objects awaiting garbage collection, and
reports classes useful for checking player lifecycles. Compare these after GC
has settled rather than interpreting a growing slot array as a leak.

The same optional profile adds `[TickProfile]` elapsed timings for the engine,
network dispatch, network flush, player upkeep and world maintenance. These
include native work and overlap the function/replication timings, so do not add
the reports together. Profiling is disabled by default. The allocation profiler
commits about 320 MiB for its own tables; compare normal memory usage with that
profiler disabled. Working-set trimming can evict resident pages without freeing
private committed memory.

Before this change, the two idle worlds measured approximately 656 MiB
(Ramsgate) and 591 MiB (Training Grounds) committed. Sleeping Training removes
its entire process allocation, rather than merely lowering its working set.

## Validation

The Release/x64 runtime and both TypeScript services compiled. The staged
metagame suite passed all 262 tests. The deploy suite passed 15 tests and skipped
its 1.12-island case with bundled older tables; rerunning the hunt-table suite
with the committed 1.12 tables passed all four cases, including that island.
The native idle-policy checks passed the five-minute boundary, player return
and unknown-connection-count cases.

Deploy regression checks cover concurrent cold starts, failed starts and retry,
requests during shutdown, late cleanup of an old world, deliberate sleep versus
crash recovery, and actual exclusive Windows file sharing. A ten-second memory
observer smoke run completed without changing the running world.

The owner approved activation on 1 October 2026. Both services restarted, the
DLL's deployed hash matched the tested artifact, and Ramsgate and John's client
logged build `112-2d8ad2a0-d2cfcbbfe6a9`. Boot opened only Ramsgate's world port;
Training Grounds stayed off. Live idle shutdown/relaunch and player join/leave
cycles remain to be observed.
