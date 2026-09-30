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
| `core/RuntimeState` | One definition of process state shared by client/server hooks |
| `core/RuntimeHooks` | Hook creation/enabling diagnostics and Windows/WARP API hooks |
| `core/RuntimeConfig` | Flag lookup; callers preserve their original defaults and caching |
| `core/Memory`, `core/Logging` | Pointer/raw-memory checks, engine allocation, shared log writer |
| `core/Transport` | HTTP and XMPP redirection; backend address comes from command line |
| `core/Features` | Feature flags, event schedules and trials scheduling |
| `core/EngineTick`, `core/PlayerRoles` | Engine tick and player-role/lifecycle repair |
| `client/ClientHooks`, `client/ClientEvents` | Client installation and ordered event dispatch |
| `client/Middleman` | Aetherdust balance/offer conversion and dust-only tiles, popup, tooltip |
| `client/Challenges` | Weekly journal handling, daily-first list, Daily Activities filtering |
| `client/HuntPass` | Library selection, coin icons, track layout and unavailable rank skip |
| `client/GameplayHUD`, `client/LootSummary` | HUD/loot lifecycle fixes |
| `server/ServerHooks`, `server/ServerEvents` | Server installation and ordered event dispatch |
| `server/Combat`, `server/PlayerData`, `server/WorldLifecycle` | Combat, player responses and world lifecycle |
| `server/Replication`, `Networking` | Native graph/channel setup and intentionally gated replication fallback |
| `diagnostics/RuntimeDiagnostics` | Crash/exit, watchdog, progression, accessory and ability diagnostics |
| `native/Addresses112.h` | Central shipping-executable RVAs, pinned to 1.12 CL392819 |
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
`data/` (databases, `account-1.12-<Name>.json` files, game data) and `logs/`.
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
writer now use the core helpers. Its flags keep their original defaults.

Unused backend authThrottle module and unreferenced IsUserIdAdmin,
UpdatePlayerLocation, GrantEntitlement, RevokeEntitlement, EarnedRank and
SetActiveHuntPassId helpers were removed. The never-populated player-location
map was removed while preserving the existing response shape. Dead imports,
locals and unused argument names were cleaned up under compiler enforcement.

Earlier investigation notes are historical evidence, not current deployment
instructions. Production compatibility adapters and operator-controlled
fallbacks are intentionally documented instead of being deleted as leftovers.

## Active runtime flags

Executable-relative flags are looked up through `MpExeRelativeFlagPresent`.
The four `debug` paths retain their original working-directory-relative lookup
through `MpWorkingDirectoryFlagPresent`. This cleanup does not enable any flag.

| Flag | Owner(s) relative to the runtime directory |
| --- | --- |
| `.\debug\DIAG_NATURAL.flag` | `server/Replication.cpp` |
| `.\debug\URL_LOG.flag` | `core/Transport.cpp` |
| `.\debug\VIEWPORT_FALLBACK.flag` | `client/GameplayHUD.cpp` |
| `.\debug\XMPP_TRACE.flag` | `core/Transport.cpp` |
| `CORE_CAPTURE.flag` | `diagnostics/RuntimeDiagnostics.cpp` |
| `DISABLE_EXPECTED_PLAYER_ZERO.flag` | `core/EngineTick.cpp` |
| `DISABLE_OWNER_PAWN_RELEVANCY.flag` | `server/Replication.cpp` |
| `DISABLE_PLAYER_HUNTID_BACKFILL.flag` | `server/PlayerData.cpp` |
| `DISABLE_PLAYER_REP_BOOST.flag` | `server/Replication.cpp` |
| `DISABLE_PLAYER_ROLE_OWNER_ROUTE.flag` | `core/PlayerRoles.cpp` |
| `EMERGENCY_LEGACY_REPLICATION.flag` | `Networking.cpp`, `server/Replication.cpp` |
| `FORCE_SERVER_MESH_POSE.flag` | `core/EngineTick.cpp` |
| `HYBRID_REPLICATION.flag` | `Networking.cpp` |
| `LEVEL_VISIBILITY_GATE.flag` | `Networking.cpp` |
| `MANUAL_TICK_HALF_RATE.flag` | `core/EngineTick.cpp` |
| `MANUAL_TICK_ZERO_DT.flag` | `core/EngineTick.cpp` |
| `MP_FORCE_WARP.flag` | `core/RuntimeHooks.cpp` |
| `NATIVE_NET_TICK.flag` | `core/EngineTick.cpp` |
| `NATIVE_REPLICATION_ONLY.flag` | `Networking.cpp` |
| `PLAYER_ALWAYS_RELEVANT.flag` | `server/Replication.cpp` |
| `REPGRAPH_DIAG.flag` | `Networking.cpp`, `server/Replication.cpp` |
| `REVERSE_CONNECTION_ORDER.flag` | `Networking.cpp` |
| `SRA_RATE_CAP.flag` | `server/Replication.cpp` |
| `TEMPEST_CHARGE_DIAG.flag` | `core/PlayerRoles.cpp` |
| `TRIALS_GRACE_DIAG.flag` | `core/EngineTick.cpp` |
| `VERBOSE_DIAG.flag` | `core/RuntimeConfig.cpp` |

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
