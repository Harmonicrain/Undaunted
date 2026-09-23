# NOTICE

This repository is a modified version of Undaunted (AGPLv3 §5). It is licensed as a
whole under the GNU Affero General Public License v3.0 (`AGPL-3.0-only`, see
`LICENSE.txt`). Additional terms under AGPLv3 Section 7 apply **only** to the
Mystic Paradox material identified below (see `ADDITIONAL_TERMS.md`).

## Modification notice

This fork (https://github.com/Harmonicrain/Undaunted) modifies Undaunted for
preserving the Dauntless `1.4.4_shipping` (CL239827) client, and is being extended
to the `1.12.0` (CL392819) client. Modifications were
made in September 2026 and are recorded in this repository's commit history.
It is not an official release of Undaunted or of Mystic Paradox.

## Provenance and attribution

### Original work: Undaunted
- Copyright (C) 2026 gwog :3 (SyST3MDeV)
- Upstream: https://github.com/SyST3MDeV/Undaunted
- Licensed under AGPL-3.0-only.

Its copyright notices are retained in the headers of the source files it originated.

### Mystic Paradox material
- Copyright (C) 2026 MysticFox / Pranav Karande
- Repository: https://github.com/pranav158/Mystic-Paradox
- Licensed under AGPL-3.0-only, with the additional terms in `ADDITIONAL_TERMS.md`.

Required attribution notice (ADDITIONAL_TERMS.md, term 1):

> "Mystic Paradox's Dauntless 1.12.0 port and related modifications were
> developed by Pranav Karande. See NOTICE.md for contribution
> and provenance information."

Material in this repository derived from Mystic Paradox (its realtime XMPP
presence/chat services), all under `UndauntedMetagame/src/realtime/`:

| File | Relationship to the Mystic Paradox original |
| --- | --- |
| `XMPPProtocol.ts`, `XMPPSession.ts`, `SessionRegistry.ts`, `authThrottle.ts`, `saslPlain.ts`, `types.ts`, `xml.ts`, `ltx.d.ts` | Unmodified copies |
| `RealtimeGateway.ts`, `XMPPAuth.ts`, `XMPPConnection.ts`, `PresenceService.ts`, `index.ts` | Modified in this fork (1.4.4 client, SQLite persistence, raw TCP listener); each file header says so |

The 1.12.0 client runtime in `UndauntedRuntime-1.12/` is imported from Mystic
Paradox's `ParadoxRuntime/` (commit `355934c`) and is being adapted for this
fork; `UndauntedRuntime-1.12/PROVENANCE.md` records the source and which files
have been modified since the import.

`RawXMPPConnection.ts` and `RawXMPPGateway.ts` are new work for this fork that use
the derived session code. The remaining social code in this fork (friends, blocks,
parties, Slayer Links) was written for this fork; it does not derive from the
Mystic Paradox sources.

The Mystic Paradox names, logos and branding are not used here to imply
sponsorship, endorsement or affiliation (ADDITIONAL_TERMS.md, terms 3 and 4).

## Notes

- This repository does not include the game client or packaged game assets.
  Credentials and keys are kept out of version control (`.env` files are ignored).
- Some data files (for example `UndauntedMetagame/src/vendor/escalation/seasons.json`
  and the store catalogue) contain identifiers and tuning values read from the
  installed client for interoperability. Their provenance is recorded in each file.
