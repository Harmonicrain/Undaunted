# Dauntless 1.12 organization and cleanup report

Date: 30 September 2026, Europe/London.

The approved cleanup is implemented, compiled, tested and installed. The local
metagame, deploy service, initial world servers and John’s client have been
restarted. The client and all three worlds observed after restart loaded the
same build. You reported that everything appears to be working.

The purpose of this work was to make the existing server and native client
patches easier to understand and maintain. Earlier Middleman, challenge, party
and HUD fixes were treated as the working baseline rather than discarded.

## 1. Preserved a recoverable baseline

Before editing, I saved the existing modified and untracked files, authored
source, project/package configuration and tests under:

a local backup folder (`organization-20260929-232638`, not in the repository)

This matters because your existing working tree already contained fixes that
were not in Git HEAD. Resetting to HEAD would have lost some of that work.
The backup includes the original monolithic runtime and the original server
controllers, along with the extraction map identifying their module ownership.

The backup excludes dependency/build directories and secret environment files.
Previous deployed outputs from this activation are also retained under the
checked build’s `previous/` folder.

## 2. Split the native runtime into owned modules

The original `UndauntedRuntime-1.12/dllmain.cpp` contained **10,898 lines**.
It now contains **46 lines** and owns the DLL entry point/export and
startup call. The implementation was moved into **25 separately compiled
translation units** across the core, client, server and diagnostics folders.

| Area | What it owns now |
| --- | --- |
| `core` | Bootstrap, build identity, runtime state, engine tick, player roles, transport, flags, memory helpers, logging and hook infrastructure |
| `client` | Middleman, challenges, Hunt Pass, gameplay HUD, loot summary and client hook/event coordination |
| `server` | Server hook/event coordination, combat, player data, replication and world lifecycle |
| `diagnostics` | Crash/exit/watchdog, ability and progression diagnostics |
| `native` | Version-specific executable addresses and verified field layouts |

These are real C++ translation units with explicit headers. The implementation
is not merely a large file divided into included text fragments. Private UI
helpers stay with their feature and the coordinator calls feature entry points.

The client’s Middleman and Hunt Pass guards still run before the original native
ProcessEvent handler. The Middleman, Hunt Pass and challenge refresh handlers
run afterward in their original order. Original calls, recursion guards and
intentional suppressed events remain in place. The server event coordinator
also retains its existing event ordering and special-case handling.

I updated the Visual Studio project and folder filters to match this structure,
used the installed **v143** toolset, and added a common precompiled header for
authored runtime files. Generated SDK and MinHook files remain separate.

## 3. Consolidated native patch infrastructure

Executable addresses now live in `native/Addresses112.h`, including the
remaining addresses formerly duplicated in Networking and feature installers.
The bindings are explicitly for **Dauntless 1.12.0, CL392819**.

Middleman field offsets live in `native/Layouts112.h` with meaningful names.
This includes the verified **0x500** `or` separator field. The earlier 0x4C0
assumption referred to the separate Added to Inventory message.

Networking now shares the core pointer/array checks, log writer and flag lookup
helpers. Log locations and stamped/unstamped line formats are preserved.
Executable-relative flags and working-directory `debug` flags remain distinct,
with their original defaults and caching behavior.

Native hook creation/enabling goes through shared wrappers that record:

- Hook/handler name.
- Target module and executable-relative address.
- MinHook create/enable result.

The wrappers preserve installation order and existing status checks. Existing
function-signature checks on the Middleman, Hunt Pass and loot patches remain.
This provides useful evidence when a hook was skipped, failed or loaded from
an unexpected DLL.

A generated build identity is logged from the loaded module. It includes the
build ID, client/server mode and actual DLL path. That addresses the earlier
uncertainty about whether a rebuilt DLL had really reached the running game.

## 4. Reorganized the metagame by feature

Gameplay code formerly collected under `src/controllers` is now organized into
**31 feature files** under these directories:

- Inventory and wallet.
- Store and Middleman.
- Challenges and Hunt Pass.
- Progression and entitlements.
- Party/matchmaking.
- Seasonal events, escalation and Slayer Links.

HTTP routes retain their authentication and request/response responsibilities.
The feature modules own game rules and persistence. Account/authentication and
shared administrative controllers remain in `controllers`, while XMPP owns
its connection/notification handling in `realtime`.

The inventory controller went from **595 lines** to a **172-line facade**;
its **283-line transaction implementation** is now a separate module. Validation,
error/result types and Middleman fusion parsing have their own owners.

The main store controller went from **431 lines** to **391 lines**, with pricing,
purchase-limit clocks and error definitions extracted. The 1.12 price-array
wire format lives in `compatibility/client112/storeOffers.ts` rather than being
embedded in the HTTP route.

Imports and test/tool entry points were updated to the new paths. The HTTP
router registration order remains the same.

## 5. Made startup and shared policies explicit

Database startup now calls `InitializeDatabase()` explicitly before API-key
registration and listening. Initialization opens the configured database,
runs migrations and existing repairs, and exposes the connection only after
those operations complete. A failed initialization closes its connection and
can be retried.

`GetDb()` now only returns an initialized connection. Importing a feature or
calling a getter no longer silently opens or migrates a database. Tests and
child-process persistence checks initialize their disposable databases explicitly.

Metagame HTTP listener configuration validates the port before binding it.
Both TypeScript packages enforce unused-import/local/parameter checks.

Shared reset calculations now live in `shared/timeWindows.ts`, while the
existing policies keep their distinct boundaries:

| Policy | UTC reset |
| --- | --- |
| Daily challenges | Daily 17:00 |
| Weekly challenges and Middleman offers | Thursday 18:00 |
| Daily store limits | Daily 00:00 |
| Weekly store limits | Thursday 00:00 |

Inventory grants, wallet changes and replay receipts still commit together in
one synchronous SQLite transaction. Moving their code did not turn them into
separate operations or asynchronous writes.

## 6. Removed proven unused and disabled code

Native unused helpers removed:

`HookVirtual`, `DumpVtable`, `ResolveWeakObj`, `EncounterableSetupHook`,
`FixupNetworkNotifyHook`, `NetConnectionCloseHook`, `PostLoginHook`,
`FindArchonReplicationGraphCDO`, `MakeDoDamageHook`, `SprintHook` and
`ApplyTrialsScheduleOffset`.

Their orphan original pointers/caches were removed too, along with:

- The no-op `InitLog` helper and its calls.
- Unused vtable-index constants.
- Disabled binary patch blocks and constant-disabled installer/diagnostic branches.
- The legacy role-repair flag branch that explicitly did nothing.
- Duplicated Networking memory checks, path construction and logging implementation.

Backend cleanup removed the unused `authThrottle` module, unreferenced
`IsUserIdAdmin`, `UpdatePlayerLocation`, `GrantEntitlement`, `RevokeEntitlement`,
`EarnedRank` and `SetActiveHuntPassId` helpers, plus compiler-reported unused
imports/locals and a never-populated player-location map. Its existing response
shape is preserved.

Active role repair, diagnostic entry points, reflected handlers and the
operator-controlled replication fallback remain. Their reachability cannot be
judged by a simple text search. The architecture notes document the active
flags and ownership so future cleanup has a concrete reference.

## 7. Preserved existing game behavior and compatibility

The cleanup retains the earlier work on:

- Middleman Aetherdust spending, effective offer prices, fusion/reveal and per-slot identities.
- Free slot unlocks and use of all three fusion slots.
- Shared weekly selection of three cell offers and their existing prices.
- Weekly challenge rotation, daily-first journal ordering and Daily Activities filtering.
- Party/matchmaking, HUD and loot lifecycle handling.
- Hunt Pass configuration, selection, rewards and layout patches.
- Currency migration, wallet routing and transaction replay protection.

Aetherdust remains the Middleman spending currency. Historical Ace Chip names
remain only where an old client wire field or data-repair compatibility path
requires the name; this does not restore Ace Chips as a separate spendable
currency. Those adapters were kept deliberately.

## 8. Added a version-aware local build/test/deploy workflow

The canonical command is `tools/Build-Local112.ps1`; the runtime `_build.bat`
delegates to it.

```powershell
powershell -NoProfile -File tools/Build-Local112.ps1 -Test
powershell -NoProfile -File tools/Build-Local112.ps1 -Deploy -Restart
```

The workflow:

1. Verifies the installed client fingerprint against `tools/client112.json`.
2. Records source hashes and generates the runtime build identity.
3. Compiles both server packages into fresh staging directories.
4. Runs their tests against staged output and disposable database fixtures.
5. Performs a clean Release/x64 native rebuild.
6. Saves the DLL, logs and manifest with source/executable/DLL identity.
7. On deployment, saves prior outputs and installs fresh server builds and both DLL copies.
8. Verifies matching deployed hashes and restarts the local 1.12 services/worlds/client.

Fresh staged output prevents obsolete compiled controllers from masking missing
imports after source moves. Tests do not copy the live `.env` or account files.
Runtime target paths are checked before filesystem moves; no computed tree is
recursively deleted.

Two checks caught issues during this work: stale module names in test imports,
and persistence-test subprocesses relying on implicit database startup. Both
were corrected before the passing build was activated.

Windows also briefly held the old mapped DLL after process exit. Copying once
it was released succeeded. The workflow now checks exclusive access to both
DLL targets before replacing deployed output. That final tooling adjustment
is recorded separately in the manifest; all production runtime/server source
files still match the checked build’s source hashes.

## 9. Verification and installed result

| Check | Result |
| --- | --- |
| Metagame regression suite | **259 passed, 0 failed, 0 skipped** |
| Deploy tests with bundled tables | 3 passed, 0 failed; the 1.12-only case was skipped |
| Deploy tests with installed 1.12 tables | **4 passed, 0 failed, 0 skipped** |
| Clean Release/x64 native build | Passed; generated SDK enum warnings remain |
| Working-tree whitespace check | Passed |
| Deployment copies | Both DLL hashes match the checked artifact |
| Metagame/deploy/XMPP listeners | TCP 61000, 61001, 61002 available |
| Initial worlds | UDP 8789 Ramsgate and 8788 Training Grounds available |
| Loaded identity | Client, both initial worlds and the subsequently started world loaded the same build |
| User smoke feedback | You reported that everything appears to be working |

The regression suite includes three new tests for explicit/retryable database
startup, invalid listener settings and the distinct reset boundaries.

Build ID checked before commit slicing:

`112-06919a10-595db78dd2da`

Both copies checked before commit slicing had SHA-256:

`44615A9A53ED29A0CDDA3C6D2B2DD1271AA11D677C86EA71BA25D42D2E4E785F`

Full logs and manifest:

`artifacts/112-06919a10-595db78dd2da-20260930-001653/` (local build output, not in the repository)

At the time of the deployment check above, these changes were uncommitted.
They were subsequently divided into local commits; the review sequence and
intermediate validation are recorded in `commit-review-2026-09-30.md`. The
series was pushed to the fork on 30 September 2026. The final DLL refresh records its source identity in
`build-112-2026-09-30.json`.
The automated tests and startup/user smoke checks establish the results above;
this report does not claim a separate exhaustive replay of every party-travel
or intermittent HUD scenario.

## 10. Where to look next time

The current map of features, interfaces, compatibility rules, reset policies,
active flags and build commands is in:

[`docs/architecture-112.md`](../architecture-112.md)

Earlier UI/party investigation notes are marked historical and point at that
current document, so their old deployment statements do not read as present
instructions. The repository README links to the 1.12 architecture/build map.

For a Middleman change, start with `client/Middleman`,
`features/middleman`, `features/inventory/transactions` and
`compatibility/client112/storeOffers`. For a native hook that did not take,
start with the loaded `[Build]` identity and `[Hooks]` status records before
changing addresses or rebuilding another DLL.
