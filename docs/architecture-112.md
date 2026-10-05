# Working on the 1.12 runtime and servers

This is the current code map, from the September 2026 organization work. The
commit series that produced it starts after `06919a10` and is described in
[the commit review](history/commit-review-2026-09-30.md). Dated session reports
live in [`history/`](history/); they record what was true at the time and are
not current instructions.

## Runtime ownership

`UndauntedRuntime-1.12/dllmain.cpp` is the DLL entry point. It retains the same
attach/init timing and export. Features compile as separate translation units;
these folders are not text fragments included into a replacement monolith.

| Folder/file | Responsibility |
| --- | --- |
| `core/Bootstrap` | Command-line setup, loaded build identity, startup/thread ownership |
| `core/RuntimeState` | One definition of process state shared by client/server hooks, and the game thread's id |
| `core/RuntimeHooks` | Hook installation (`RUNTIME_INSTALL_HOOK`: one log line per hook) and Windows API hooks |
| `core/Settings`, `core/SettingsParse.h` | The `-Undaunted` switches, read once (see [runtime settings](#runtime-settings)) |
| `core/Memory`, `core/Logging` | Pointer/raw-memory checks, engine allocation, shared log writer |
| `core/Transport` | HTTP and XMPP redirection; backend address comes from command line |
| `core/Features` | Feature flags, event schedules and trials scheduling |
| `core/PlayerRoles`, `core/LoadingGate` | Applying player roles and retrying them; the loading check both sides hook |
| `client/ClientHooks`, `client/ClientEvents` | Client installation and ordered event dispatch |
| `client/Credits`, `client/CreditsContent`, `client/CreditsInsert` | Prepend this fork's contributors to the existing credits, using native text styling; preserve original sections and slot layout, restore them on insertion failure |
| `client/TitleBackground`, `client/TitleBackgroundTiming` | Crossfade and gently zoom installed login artwork on the title screen; retain the original controls and static-art fallback |
| `client/LoadingBackground`, `client/LoadingBackgroundChoice`, `client/BackgroundArt` | Choose installed artwork once per normal loading screen without consecutive repeats; share the title artwork pool, preserve tips and loading UI |
| `client/PlayerRoleActivation` | Activating the possessed pawn's input and gameplay once its role is applied |
| `client/Middleman` | Aetherdust balance/offer conversion and dust-only tiles, popup, tooltip |
| `client/SlayerLinks`, `client/SlayerLinkRecoveryPolicy` | Recover missing native prize-pool activation; defer an unlock until its pool and UI are ready, then resume native collection once |
| `client/Challenges` | Weekly journal handling, daily-first list, Daily Activities filtering |
| `client/HuntPass` | Library selection, coin icons, track layout and unavailable rank skip |
| `client/GameplayHUD`, `client/LootSummary` | HUD/loot lifecycle fixes |
| `server/ServerHooks`, `server/ServerEvents` | Server installation; ProcessEvent handlers, chosen once per function |
| `server/ServerTick`, `server/WidgetGuards` | The world's frame around the engine tick, in named steps; widget calls skipped on servers |
| `server/WorldState`, `server/WorldWatchdog` | The current game mode and game state; empty hunt island shutdown and the hung game thread watch |
| `server/Bleedout` | The island bleed-out duration fix, downed-player watch and bleed-out diagnostic |
| `server/Combat`, `server/PlayerData`, `server/WorldLifecycle` | Combat, player responses and world lifecycle |
| `server/PlayerRoleRouting` | Routing player role actors to their owner's connection; Tempest modifier repair |
| `server/WeeklyChallenges` | Weekly challenge tables limited to the metagame's selection |
| `server/TrainingLifecycle`, `server/TrainingIdlePolicy` | Training Grounds idle grace and shutdown coordinated with deploy travel reservations |
| `server/Replication`, `server/Networking` | Net driver creation, the native replication graph and its guards |
| `diagnostics/ExitTrace`, `diagnostics/HangTrace` | How a process ends; where a hung game thread is |
| `diagnostics/PlayerRoleDiagnostics`, `diagnostics/EscalationTrace` | Log summaries of player roles and abilities; the Escalation flow trace |
| `native/Addresses112.h` | Central shipping-executable RVAs, pinned to 1.12 CL392819, every one named |
| `native/CodePatch` | Instruction patches that check the original bytes first |
| `native/Layouts112.h` | Verified Middleman reflected/native field offsets |

The generated SDK and MinHook remain third-party/generated code. Their broad
API surface is not evidence of an unused feature. Do not hand-edit the SDK to
repair one widget.

Client event dispatch runs Middleman and Hunt Pass guards before the original
ProcessEvent call, then feature UI refreshes after it, in the original order.
The client/server recursion guards and intentional absorbed events remain.
New handlers belong to their feature owner; preserve original calls and the
ordering requirements when adding them. Hook wrappers retain the existing
create/enable order and status checks, and log hook names, targets and results.
Signature checks on the existing Middleman, Hunt Pass and loot patches remain.

The popup's `or` field is **0x500**. The former 0x4C0 guess is the separate
Added to Inventory message. This distinction is named in `Layouts112.h`.

## Server ownership

`UndauntedMetagame/src/routes` handles HTTP/authentication and translates
requests to feature operations. `src/realtime` owns XMPP connections and
notifications. `src/controllers` retains account/authentication and shared
administrative controllers; it is no longer the home of every gameplay system.

| Feature directory | Responsibility |
| --- | --- |
| `features/middleman` | Shared weekly cell offers and per-slot fusion save validation |
| `features/inventory` | Item validation/types and atomic inventory/wallet/receipt transactions |
| `features/wallet` | Canonical currencies and balance operations |
| `features/store` | Catalogue, purchase processing, pricing, limits, note redemption |
| `features/challenges` | Bounty state and daily/weekly board rotation |
| `features/huntpass` | Configuration, library and reward processing |
| `features/progression` | Track state, monotonic writes and tracked objectives |
| `features/party` | Party membership, matchmaking and party travel notifications |
| `features/entitlements`, `features/events` | Ownership and seasonal event windows |
| `features/escalation`, `features/slayerLinks` | Escalation and Slayer Link state |
| `compatibility/client112/storeOffers` | The client's price-array DTO format |
| `shared/timeWindows` | Named reset boundaries; intentionally distinct clocks |
| `config/environment` | Validated HTTP listener settings and database filename |

Wallet charges, inventory grants and transaction receipts still commit within
one SQLite transaction. Splitting modules must not split that transaction into
separate commits or asynchronous writes. Shared validation/error types keep
`instanceof` identity stable across modules.

`InitializeDatabase()` is called explicitly from server startup before API-key
registration and listening. It opens the configured database, runs migrations
and historical repairs, and only then exposes the connection. `GetDb()` is a
getter and refuses access before initialization. Importing a feature no longer
silently opens/migrates a database. CLI entry points that need the database
must initialize it explicitly too. Tests use checked disposable paths; they
never load the live `.env` or player database.

Aetherdust is the Middleman's real spending currency. Historical Ace Chip
names are retained only where the 1.12 client wire contract or existing-data
repair requires them; they are not another supported spending currency.

| Reset policy | UTC boundary |
| --- | --- |
| Daily challenges | Daily 17:00 |
| Weekly challenges and Middleman offers | Thursday 18:00 |
| Daily store purchase limits | Daily 00:00 |
| Weekly store purchase limits | Thursday 00:00 |

Both TypeScript packages enforce unused local/import/parameter checks. Public
functions and reflected C++ handlers still require a reference/entry-point
review before deletion; compiler checks alone do not prove they are dead.

## Build, test and deployment

From the repository root:

```powershell
# Compile both server packages and Release/x64 runtime; test staged packages.
powershell -NoProfile -File tools/Build-Local112.ps1 -Test

# Compile/test first, then activate fresh server outputs and matching DLLs,
# and restart the local 1.12 servers, worlds and client.
powershell -NoProfile -File tools/Build-Local112.ps1 -Deploy -Restart
```

`UndauntedRuntime-1.12/_build.bat` delegates to the same workflow. It discovers
MSBuild and uses the installed v143 toolset. Dependencies must already be
installed from each package's lockfile.

Machine-specific paths are never stored in the repository.
`tools/Local112Config.ps1` resolves them for every script, in this order: a
`-DataRoot` / `-GameDirectory` parameter, the `UNDAUNTED112_DATA_ROOT` /
`UNDAUNTED112_GAME_DIR` environment variables, then `tools/local112.json`
(ignored by git; copy `tools/local112.example.json`). The data root holds
`data/` (databases and `account-1.12-<Name>.json` files) and `logs/`. The
1.12.0 game data is in the repository, in `data/1.12`.
`-Test` needs neither path, `-Deploy` needs the game directory and `-Restart`
the data root. Ports come from the packages' `.env` files.

| Script | Purpose |
| --- | --- |
| `tools/Build-Local112.ps1` | Build, test and optionally deploy and restart the stack |
| `tools/Start-Local112.ps1` | Start the metagame, deploy server and initial worlds, then optionally a client (`-ServerOnly`, `-Account`) |
| `tools/Launch-Local112.ps1` | Launch the 1.12 client for an account |
| `tools/New-Account112.mjs` | Add an account (backs the database up first; the key is saved, never printed) |

The deploy step builds `UndauntedRuntime-1.12/MysticParadox.sln` and installs
the DLL in the 1.12 game directory as `UndauntedInternalServer.dll`, the name
the game loads. The 1.4.4 runtime and launcher are on the `1.4.4` branch.

Every run stages fresh compiler output under ignored `artifacts/`, so deleted
source modules cannot be masked by stale compiled controllers. Tests run against
that staged output with the existing test harness and source/vendor fixtures.
Deploy requires passing tests. Activation saves previous server output and DLLs
under the build's `previous/` directory, then checks the deployed DLL hash.
Nothing is recursively deleted from a computed workspace path.

`tools/client112.json` pins the shipping executable SHA-256, version, changelist,
platform and toolset. A different installed executable is refused before native
deployment. Revalidating a new client build means reviewing RVAs, SDK layout
and existing function signatures together, not just changing the hash.

A build directory contains `sources.sha256`, compiler/test logs, the DLL and
`manifest.json` with source identity, executable fingerprint, DLL hash and
activation state. The generated build identity header is ignored. Client and
world logs emit `[Build] id=... mode=... module=...`, so a copied DLL and a loaded
DLL can be distinguished. Direct IDE builds remain possible and identify
unlabelled output explicitly. Native compiler warnings in generated SDK enum
fields are tracked separately from authored-code errors.

The account exchange key is never printed by build/restart diagnostics. The
local account and server environment files are not copied into build artifacts.

## Removed or consolidated code

Proven unused native helpers removed: HookVirtual, DumpVtable, ResolveWeakObj,
EncounterableSetupHook, FixupNetworkNotifyHook, NetConnectionCloseHook,
PostLoginHook, FindArchonReplicationGraphCDO, MakeDoDamageHook, SprintHook and
ApplyTrialsScheduleOffset, with their orphan original pointers/caches. The
no-op InitLog helper/calls, unused vtable constants, disabled binary patch
blocks, constant-disabled installers/diagnostic block and the legacy no-op
role-repair flag branch were removed. The active role repair and gated native
replication fallback remain.

Networking's duplicate pointer checks, executable path construction and log
writer now use the core helpers.

The October 2026 cleanup (no change to what players see unless noted):

- **Flag files.** The 26 flag files next to the executable or in a `debug`
  folder are gone; none were in use. Diagnostics became `-UndauntedDiag`
  channels. The kill switches for always-on fixes (expected player count,
  owner pawn relevancy, hunt id backfill, player replication rate, player role
  routing) were removed with the fixes kept. The experiments were removed with
  their code: the manual actor-replication loop and its five switches
  (`Networking`), the replication rate cap, always-relevant players, half-rate
  or zero-delta manual net ticks, the native-net-tick mode, the forced server
  mesh pose, the WARP software renderer hooks, "natural mode" and the viewport
  size fallback (with its hook). Two environment variables for Trials became
  switches; `MYSTICPARADOX_BLEEDOUT_SECONDS` (never set) became the fixed 30 s.
- **Dead code.** Toggles that always returned the same value, a hook that only
  called the original (`IsLevelInitForActor`), a write of LogBeacon's log level
  that the game's own static initializer overwrote, the launch-ready marker for
  Mystic Paradox's launcher, console output, a client debug key handler (F7)
  in the server-only engine tick, and startup probe dumps.
- **Structure.** `diagnostics/RuntimeDiagnostics` (1,157 lines) became
  `ExitTrace`, `HangTrace`, `PlayerRoleDiagnostics` and `EscalationTrace`, with
  the behaviour it held moved to `server/Bleedout` (the bleed-out duration fix
  used to run only as a side effect of the empty-world check) and
  `server/WorldWatchdog`. The two empty-world shutdowns (game thread and
  watchdog thread) are one; the thread now only watches for a hung game thread.
  `core/EngineTick` (server-only) became `server/ServerTick` in named steps.
  `ProcessEventHook` (625 lines) decides what to do once per function instead
  of searching every call's name 15 times; one-off investigation logging
  (weapon XP, perfect dodge, possession, MustSpectate, connection dumps) was
  removed. The PlayerCanRestart view-target write ran only for a world's first
  five calls because it sat inside a log budget; it now always runs, as every
  hunt island already had it. Four walks over every object to find the game
  mode use `server/WorldState` instead. `core/PlayerRoles` was split into its
  shared, client (`client/PlayerRoleActivation`) and server
  (`server/PlayerRoleRouting`) parts, the weekly challenge table patch moved
  from `client/` to `server/WeeklyChallenges`, and the instruction patches to
  `native/CodePatch`.
- **Addresses.** All 63 `Rva_<number>` constants have names. The player role
  slot patch now checks the original bytes before writing.
- **Checks.** `test/settings.test.cpp` covers the switch parser, and
  `tools/Test-WorldStartup112.ps1` runs after `Build-Local112 -Restart`: every
  world must run the new build, listen, and report no failed hook or patch.

Unused backend authThrottle module and unreferenced IsUserIdAdmin,
UpdatePlayerLocation, GrantEntitlement, RevokeEntitlement, EarnedRank and
SetActiveHuntPassId helpers were removed. The never-populated player-location
map was removed while preserving the existing response shape. Dead imports,
locals and unused argument names were cleaned up under compiler enforcement.

Earlier investigation notes are historical evidence, not current deployment
instructions. Production compatibility adapters and operator-controlled
fallbacks are intentionally documented instead of being deleted as leftovers.

## Runtime settings

The runtime reads `-Undaunted` switches from its command line once
(`core/Settings`); there are no flag files. World servers get them from
`GAMESERVER_EXTRA_ARGS` in the deploy server's `.env`, a client from its launch
arguments, and each process logs the ones it was given (`[Settings]`). The
world server switches are listed under [world server cost](#world-server-cost);
the others:

| Switch | Effect |
| --- | --- |
| `-UndauntedMetagame=<host:port>` | Client: the metagame to send backend requests to |
| `-UndauntedTrialsRotationMinutes=<n>` | How long each Trials week lasts (default a week) |
| `-UndauntedTrialsWeek=<1-181>` | The Trials week to start from |
| `-UndauntedDiag=<channels>` | Diagnostics, comma-separated (all off by default): `repgraph` replication graph state and per-class replication counts; `verbose` the game thread's recent calls for hang reports, the first 180 net ticks and default map lookups; `bleedout` every player's bleed-out state a few times a second and knockouts; `tempest` Tempest player role charge; `items` item grants and consumption; `escalation` the Escalation relic flow; `urls` backend request URLs; `xmpp` XMPP traffic |

## World server cost

Training Grounds starts on its first travel request and sleeps after five empty
minutes. Concurrent requests share one launch, and travel reservations prevent
an idle shutdown while a player is loading. Ramsgate stays ready at boot.
See [the lifecycle and memory measurement guide](world-memory-2026-10-01.md)
for the shutdown protocol, regression checks and manual join/leave observations.

World servers run the client executable with `-nullrhi`, so by default they
carry client-only costs. The runtime trims them on world servers only
(measured 2026-09-30, per world including child processes):

| Change | Where | Effect |
| --- | --- | --- |
| Frame rate set by the runtime: the active rate with a player connected, the idle rate after 10 s empty | `server/ServerTick.cpp` | Idle world ~70-86% of a core down to 5-7% |
| `ExpectedPlayerCount` holders read from the world's game mode and game state instead of walking every object each frame | `server/ServerTick.cpp` | About a third of an idle world's CPU |
| The engine's frame limiter waits on a high-resolution timer instead of spinning `SwitchToThread` through the last ~2 ms of every frame (a client build's limiter; a dedicated-server build sleeps) | `server/FrameWait.cpp` | Measured 2026-10-01 at 90 fps: empty Ramsgate 40% of a core down to 24%; Ramsgate with a player 55% down to 36%. A late timer wake occasionally stretches a frame (worst 18.7 ms against 14.5 ms in a minute) |
| Per-call overhead cut from the runtime's hottest hooks: the replication guards identify player controllers with guarded reads instead of a VirtualQuery per actor per connection, ProcessEvent caches each function's full name per thread, feature flags are decided once per class, escalation tracing rules functions out with one search, and a debug flag file is looked for every 4 s instead of every frame | `server/Replication.cpp`, `server/ServerEvents.cpp`, `core/Features.cpp`, `diagnostics/EscalationTrace.cpp`, `server/ServerTick.cpp` | Emberthorne Cove with two players at 30 fps: 30% of a core down to 20%, 9.3 ms of work per frame down to 5.6 ms (profiled 2026-10-01) |
| Behemoths' pooled projectiles and loot drops (hidden at the origin, always relevant) skip replication checks once a check has found nothing to send, until they leave the pool; quiet player controllers (which carry every progression component) and behemoth parts are checked at 10 Hz instead of every frame until something changes | `server/Replication.cpp` | Emberthorne Cove with two players: replication 47 ms/s down to 22 ms/s (8,447 checks/s down to 2,741). A first change after a quiet spell can reach clients up to 66 ms later |
| CPU copies of mesh and texture render data freed; `r.FreeSkeletalMeshBuffers` set before content loads; cube maps included | `server/RenderData.cpp` | Ramsgate's own process ~1,245 MB down to ~860 MB |
| Distance fields (105 MB on Ramsgate), render sections' duplicated-vertex buffers (29 MB) and morph target deltas (30 MB) emptied, found with the allocation profile below | `server/RenderData.cpp` | Ramsgate ~855 MB down to ~690 MB committed |
| The engine's 32 MB backup out-of-memory pool released after load | `server/WorkingSet.cpp` | 32 MB committed per world |
| The WebBrowserWidget plugin's startup skipped, so Chromium and `UnrealCEFSubProcess.exe` never start | `server/RenderData.cpp` | ~130 MB per world |
| Working set emptied 30 s after load, 60 s after a player joins and whenever the world has been empty for 15 s | `server/WorkingSet.cpp` | Resident memory down to ~60-85 MB idle, ~100-160 MB with a player |

Empty Ramsgate commits ~660-690 MB, the Training Grounds ~590-600 MB and a
hunt island with one player fighting ~670 MB; each player adds ~30 MB. Most
of that is read only while loading. After the trim a world keeps only what it touches resident:
emptying a world's working set and watching it refill (2026-09-30) gave 85 MB
for an idle Ramsgate, 125-180 MB with a player running around it (garbage
collection accounts for ~55 MB) and ~160 MB for a hunt island mid-fight. The
trimmed pages stay committed on Windows' modified list; they are the first to
go to the pagefile or compressed memory when RAM runs short, so a host needs
pagefile (or RAM) for the full commit but RAM only for the resident part.

| Command-line switch (world servers) | Effect |
| --- | --- |
| `-UndauntedServerFPS=<n>` | Frame rate while players are connected (default 90, the rate worlds used to inherit from the host's graphics settings). Measured 2026-10-01 with a player in Ramsgate: 36% of a core at 90, 23% at 60, 13% at 30; hunts at 60 and 30 played the same as at 90. Set it for every world with `GAMESERVER_EXTRA_ARGS` in the deploy server's `.env` |
| `-UndauntedIdleFPS=<n>` | Frame rate once the world has been empty for 10 s (default 10) |
| `-UndauntedFrameSlackUs=<n>` | How early the frame limiter's timer wakes before a frame is due, in microseconds (default 500); the limiter spins the rest |
| `-UndauntedKeepFrameSpin` | Leave the engine's frame limiter spinning |
| `-UndauntedKeepRenderData` | Keep all render data (turns off the release and the skeletal-buffer setting) |
| `-UndauntedKeepWebBrowser` | Let the WebBrowserWidget plugin start Chromium |
| `-UndauntedKeepWorkingSet` | Don't trim the working set |
| `-UndauntedTrimSeconds=<n>` | Also trim every n seconds (default 0, off) |
| `-UndauntedAfkTimeoutSeconds=<n>` | AFK kick timeout for players in this world, in seconds; 0 never kicks. The client kicks itself using the timeout its world's game state replicates (the game modes default to 600 s), so this needs no client change |
| `-UndauntedKeepParkedReplication` | Check pooled actors parked at the origin every time, as before |
| `-UndauntedKeepQuietReplication` | Check quiet player controllers and behemoth parts every frame, as before |
| `-UndauntedServerTickFilter` | Answer the Blueprints' `TickFilterHelper` as a dedicated server would for actors the world controls: work for the server ("server only", "local or server", "all") runs where its island/town test passes, work for the owning client or other clients' copies doesn't. The client build answered as if the server were another player's client, so the player character's server tick never ran. With the switch its own tick runs stamina (the runtime's per-frame `TickStamina` call stops), the bleed-out countdown and the 0.5 s timer that records where edge recovery returns a fallen player; the combat animation Blueprint skips seven client-only pose calculations. Checked in a hunt 2026-10-01 (stamina refills, the recovery point follows the player); off by default until downing and falling off an island are checked with players |
| `-UndauntedTickFilterCensus` | Diagnostic: count `TickFilterHelper` calls by Blueprint call site, with the game's answer and a dedicated server's (`[TickFilterCensus]`, once a minute) |
| `-UndauntedScriptProfile=<n>` | Diagnostic: time ProcessEvent by function and actor replication by class; report elapsed engine/network/upkeep/maintenance phases and registered-object counts every n seconds (`[ScriptProfile]`, `[RepProfile]`, `[TickProfile]`, `[ObjectProfile]`). Reports overlap; object counts include defaults and pending GC. Set through `GAMESERVER_EXTRA_ARGS` only while measuring |
| `-UndauntedAllocProfile=<n>` | Diagnostic: record which call stacks own the engine allocator's live memory and write the largest to `allocprofile-<pid>.tsv` next to the executable every n seconds. Its own tables commit about 320 MiB outside those engine allocations; measure normal commit with profiling off. Slow; test worlds only |

What the ~650 MB left on an empty Ramsgate is, from that profile (2026-09-30):
the asset registry (~59 MB), PhysX collision (~50 MB), compressed animations
(~45 MB), pak indexes (~20 MB), the PlayFab catalog (~15 MB), reflection data,
data tables and localisation (~10-15 MB each), UObjects themselves (~40 MB) and
engine startup allocations. The server uses most of these; the asset registry
and localisation might not be needed, but dropping them safely would take
deeper changes than freeing data behind an asset.

The DLL log shows the effect: `[Perf]` once a minute (frames, frame times,
engine versus runtime time, connections), `[ServerFps]` on each rate change and
`[RenderData]` after each release pass (freed, kept for CPU access, faulted),
`[WorkingSet]` after each trim (working set before and after, commit),
`[FrameWait]` with each `[Perf]` (timer waits, how far from the frame's end
they woke, spin calls), `[ParkedActors]` and `[QuietReplication]` (replication
checks skipped) and `[AllocProfile]`, `[ScriptProfile]`, `[RepProfile]`,
`[TickProfile]` and `[ObjectProfile]` when
profiling.
Shipping builds ignore `-ini:` overrides and have no `memreport` or `obj list`,
and `ExecuteConsoleCommand` needs a player controller, so the runtime writes
console variables through their data pointers (`native/Addresses112.h`).

## Validation record

Completed 30 September 2026 (local time):

- Metagame: 259 passing tests, zero failures, including the three new startup/reset regression tests.
- Deploy server: three passing bundled-table tests, one 1.12-only case skipped with bundled data; all four passed again using the installed 1.12 hunt tables.
- Clean Release/x64 runtime rebuild passed. Generated SDK enum warnings remain; no authored-code build errors.
- Both deployed DLL copies (at the time, the game directory and the launcher assets) match SHA-256 `44615A9A53ED29A0CDDA3C6D2B2DD1271AA11D677C86EA71BA25D42D2E4E785F`.
- Client and both initial worlds report loaded build `112-06919a10-595db78dd2da`; TCP 61000/61001/61002 and UDP 8788/8789 are live, and the metagame status endpoint is ready.
- User reported that the restarted stack appears to be working.

The manifest is `artifacts/112-06919a10-595db78dd2da-20260930-001653/manifest.json`.
During activation, Windows briefly retained the old mapped DLL after process
exit. Copying after release succeeded; the workflow now waits for exclusive
access to both targets before replacing any deployed output. Its updated hash
is recorded separately from the runtime/server build source identity.

This records startup, automated regression and user smoke feedback. It does
not claim a separate exhaustive replay of every multi-player/UI scenario.
