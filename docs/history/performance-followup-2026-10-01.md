# Performance follow-up, 1 October 2026

Reviewed recent commits through `e8fcd522` and inspected the running world
without changing account data or driving the game UI. Subsequent fixes were
authorized by the owner. No commits or pushes were made.

## Reproduced allocation bugs and fixes

Public Hunting Grounds selection awaited deploy before recording reservations.
Concurrent requests could therefore create several worlds for the same island
or reserve the same last slot. Regression tests reproduced four worlds instead
of one and two joiners taking one remaining slot. A solo player requesting their
current island also received a new world because selection required another
player to be present.

Public selection, allocation and reservation now run in sequence per island.
Other islands and private hunts remain independent. Failed allocations release
the queue so retries can proceed. A player's occupied public world is eligible
for reuse even when their party is its only occupant. All 13 Hunting Grounds
tests pass, including the three previously failing cases and failure recovery.
This avoids unnecessary world processes; no quantified RAM saving has yet been
measured after activation. The registry remains in memory and is not recovered
across metagame restarts.

## CPU and memory findings

- A two-player Ramsgate sample showed approximately 1.84 ms/frame inside the
  engine and 1.74 ms/frame in runtime-managed work at 30 FPS. The latter includes
  native network calls and is not all avoidable patch overhead. Stamina ticking
  accounted for only about 2.92 ms/s, so changing gameplay timing was not justified.
- The existing object counter was array size, including destroyed-object holes.
  A read-only snapshot at 15:56:55 UTC found 129,951 slots but 95,509 registered
  objects, with no read faults. Defaults and pending-GC objects are included.
  A single snapshot cannot establish a leak; repeated join/leave cycles are needed.
- The additional callback in the original disconnect routine targets an Online
  Beacon host. The running IpNetDriver's callback pointer was null. No evidence
  justified altering that disconnect hook, and it remains unchanged.
- An observed join-triggered working-set trim took about 54.6 ms. It evicts
  resident pages without necessarily reducing private commit. Trimming remains
  unchanged pending a controlled comparison of page faults and frame latency.
- The allocation profiler's own tables commit about 320 MiB outside its engine
  allocation report. Historical allocation reports are useful for identifying
  owners, but profiling-on private commit is not a production baseline.

## Diagnostic and headless-world changes

Optional script profiling now reports elapsed engine, dispatch, flush, player
upkeep and maintenance phases, plus registered-object counts and class summaries.
These elapsed timings overlap the existing script and replication reports.
Object scans occur only at enabled profile reporting intervals. The normal memory
log says `object slots`; the CSV separates slots from registered counts and uses
-1 for unknown counts. Parser checks cover old/new logs, freed slots and PID
isolation. The allocation profiler reports its own table allocation explicitly.

The global F7 debug object scan and key-release busy loop are now restricted to
clients, preventing a headless world from responding to keyboard input on the
host PC. Frame rates, replication policies, stamina behavior and memory-release
policies were not changed.

## Validation and activation

Staged build `112-e8fcd522-a975aa6789b4` compiled both TypeScript services and the
Release/x64 DLL. Metagame: 275 passed. Deploy: 18 passed, with one 1.12-only
island case skipped against bundled older tables; rerunning the four hunt-table
checks with committed 1.12 data passed all four without skips. Native object-census,
Slayer Link recovery and Training Grounds policy checks passed. Memory-log
parser checks passed. The build manifest records `testsPassed: true` and
`deployed: false`; this build has not been activated or measured live.

Next measurements should separate native dispatch/flush from player upkeep,
compare settled registered counts and private commit over three identical
join/leave cycles, then compare trim-enabled/disabled latency. Asset registry,
animation and collision allocations need ownership and gameplay validation
before any further release is attempted.
