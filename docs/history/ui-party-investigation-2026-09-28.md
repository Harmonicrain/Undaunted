> Historical investigation notes. See [the current architecture and build workflow](../architecture-112.md) for current ownership and validation. Deployment statements below describe the original investigation date.

# Daily Activities, party return, and intermittent HUD failures

## Daily Activities

The client-only ProcessEvent hook now collapses the weekly objective box,
weekly heading, and weekly countdown on `UHUDChallengeObjectiveTracker`.
It does not change the weekly board or the Challenges journal. Daily,
collectibles, and fountain controls are retained.

Release/x64 compiled successfully with VS2022 v143 on 28 September. The
result is `UndauntedRuntime-1.12/x64/Release/MysticParadox.dll`. This build
has not been installed over the running client/server DLL or visually verified.

## Leave with Party

User confirmed the affected players were invited party members.

Observed in the 1.12 metagame log (`metagame-1.12.log`), approximately lines
14307–14364 (19:16:48–19:17:00 UTC):

- John's CITY request allocated Ramsgate with **two expected players**.
- The allocation succeeded on port 8789. John travelled immediately.
- Manda subsequently left the shared party chat, joined a different party
  chat, and issued a separate CITY request with one expected player.

This proves the backend included both players in this allocation. It does
not prove why the follower did not travel automatically or why they left
the party; that may include their manual recovery actions.

Relevant implementation:

- `controllers/matchmaking.ts`: leader requests replace every party member's
  candidate; ready candidates are immediately marked ready.
- `routes/party.ts`: `/party/status` reports each requester's candidate as
  `IN_PROGRESS` once ready. There is no distinct party travel acknowledgement.
- `routes/matchmaking.ts`: `/candidate/status` exposes the same destination.
- No party/candidate-change notification producer was found in the realtime
  implementation. Polling is the available backend mechanism; whether it
  matches the native in-island client behavior remains to be verified.
- A separate confirmed code defect: a nonleader's join request simply returns
  whether *any* previous candidate exists, without comparing destination. This
  can accept a CITY request while retaining an old island candidate. It does
  not explain the leader-initiated occurrence above on its own.

Native `AArchonPartyClient::StartTravelToCity` (1.12 RVA `0x1AF19C0`)
distinguishes `bLeaveWithParty`: the solo path leaves the party first; the
party path checks leadership and starts hunt matchmaking. Follower reaction
to updated party/candidate state still needs a paired live trace.

No party behavior changes were made during this investigation.

### Follow-up: leader removed and Todd stranded

User reports clicking Leave with Party removed John from the party and left
Todd unable to return. A likely matching logged sequence on 28 September:

- 18:30:46 UTC (19:30:46 BST): John's CITY allocation contained one player.
- 18:30:50 UTC: John joined a different party chat.
- 18:33:29 UTC: Todd issued a separate CITY request with one expected player.

This is different from the two-player allocation described above. The request
capture cap had already reached 25 for DELETE /party/member, so those later
removal requests were no longer logged. The removal initiator and client
`bLeaveWithParty` value cannot be recovered from this capture.

A disposable-database probe with a fake local allocator confirmed:

1. With a two-member party still present, the follower's CITY request returns
   success, performs no allocation, and retains the existing ISLAND candidate.
2. After explicitly removing the leader, the backend promotes the remaining
   member and successfully allocates CITY when that member requests it.

Therefore the stale-candidate guard is a real defect, but leader removal alone
does not reproduce the stranded state in the backend. The failing live case
also needs native party membership/leadership and menu callback state captured;
do not claim the guard alone explains the accidental party removal.

## Missing enemy-health HUD

The native `UHUDBehemothHealthManagerWidget` owns three health-state widgets
and a pending-behemoth queue. Spawn, cleanup, and loadout callbacks control
its lifecycle. Each state widget holds a weak behemoth reference, health
widget, area view model, and distance thresholds. Missing registration,
cleanup, or visibility conditions must be distinguished using live state.

The existing client hook also has custom airship HUD reconciliation and input
activation. Their existence is not evidence that they caused this symptom.

The sampled client had no active health manager, only an unbound widget
template. It was not a reproduction. No cause or fix is confirmed.

## Loot summary Back

`UMatchLootSummaryScreen` inherits `UArchonScreen` lifecycle and transition
state. Back is not implemented by a loot-specific backend endpoint. The
current hook does not explicitly suppress the loot Back action; the rank-skip
suppression is restricted to the Hunt Pass screen.

Need to capture the actual stuck screen: whether clicking and Esc both fail,
whether its transition flag stays set, and which widget/input state owns the
screen. There was no live loot summary in the sampled client. No cause or fix
is confirmed, and forcing the overlay closed would hide the failure.

## Read-only reproduction capture

A local inspection script (`inspect-live-ui112.py <client-PID>`, not in the
repository) uses
`PROCESS_QUERY_INFORMATION | PROCESS_VM_READ` only. It reports health-widget
bindings/queue, loot lifecycle flags, party objects, and native function RVAs.
Run while a reported symptom remains on screen, before restarting. The
reader does not invoke game functions or modify process memory.
