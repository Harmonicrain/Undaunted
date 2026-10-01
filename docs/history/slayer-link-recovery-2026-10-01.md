# Slayer Link unlock recovery

John's expired link with Todd had 1,270 shared XP (three earned chests), but
neither participant had a stored prize pool. Unlock reached the gameserver and
`GET /slayerlink/links/rewards/<account>/1` returned 409: the pool was missing.
The backend retained the link and earned rewards rather than deleting them.

Read-only inspection of John's 1.12 client found two native link rows: Todd in
slot 1 with zero pool entries and Manda in slot 2 with twelve. The pending native
activation marker was zero. The older 1.4.4 runtime contained recovery for this
missed activation; the 1.12 runtime did not contain its equivalent.

The 1.12 callback was verified at RVA `0x01B413F0` from its unwind range and
disassembly: 0x68-byte link rows, slot at +0x48, pool count at +0x58, expiration
at +0x30, and owner activation marker at +0x148. The callback compares the marker
with the slot, broadcasts activation and clears the marker. These layouts also
matched the two live rows. A 31-byte executable signature guards installation.

`client/SlayerLinks.cpp` now re-arms that marker when an authoritative link row
has a missing pool, before calling the original callback. The game retains
ownership of pool generation, storage, grants and UI updates. Existing pools
are untouched; another slot's pending activation is preserved. Retries are
limited to once per slot/end date every 30 seconds, with one activation per
callback. No player XP or inventory was manually edited.

The standalone policy checks cover existing pools, pending activations,
multiple slots, the retry boundary, a replacement link, a replacement local
owner and invalid inputs. The existing native-test entry point now discovers
all `test/*.test.cpp` policy tests, so both Training and Slayer Link policies
run in the staged build. Release/x64 build `112-65413909-b5185682800b` compiled
successfully; 262 metagame tests, 16 deploy tests and both native policy tests
passed. One bundled-table deploy case was skipped.

The owner approved activation. Both services, Ramsgate and John's client were
restarted; the world and client logs identify the tested build. The client's
`SlayerLinkRecovery enable=MH_OK` confirms the executable signature matched and
the hook installed. The backend's configured reward table also matches the
committed 1.12 data. Native generation then stored John's twelve-entry pool.
The owner's second unlock collected 8 + 2 premium bounty tokens and 90
Aetherdust. Read-only database inspection confirmed one claim transaction and
John's side released; Todd's side remained unreleased. No manual grant occurred.

The first attempt exposed a second issue: the pool was stored but the client's
cached state had not received it. No reward GET or grant happened; instead the
client sent a DELETE, which the entitlement guard refused with 409. Native
`LinkedSlayerScreen.OnActionButtonClicked` dispatches through `0x01FBFA20`:
status 7 collects, while status 8 deletes without collecting. A missing pool
can take that empty-reward path and open an empty summary.

Native row comparison (`0x01AF7CF0`) checks identity, slot, state, expiry and
progress, but omits the prize pool. On a missing pool's arrival the patch
temporarily uses marker 0 to bypass this equality shortcut without activating
any slot; it restores -1 afterward if native has left it at 0. This lets native
update the cached row and UI even when no other link field changed.

The additional client guard queues one unlock if that expired link's native
row still lacks its pool. Its button displays "Preparing rewards...". After
the native data callback has updated both the row and UI pool, the guard
consumes the queued action and resumes native dispatch. It cancels on screen
close, another selection, link replacement or a one-minute timeout. Native
weak-object serials protect against object reuse; a UI model replacement for
the same link can still complete the queued action. Populated pools and active
links follow their original path. A legitimate zero-progress link can still
use native deletion after its pool loads. Policy tests cover the retry,
single-resume, cancellation, timeout and replacement boundaries.

Release/x64 build `112-65413909-00b08415d244` passed all 262 metagame tests,
16 deploy tests (one expected skip), and both native policy tests. Its source
inventory matches the working tree. This additional guard still needs a
deployed client test. John's collected
link was not reset or granted again to manufacture a reproduction. The
unavailable-relink message is consistent with Todd's uncollected side.
