# Private server credits (1.12)

The client runtime adds a section immediately before Phoenix Labs in the original
credits roll, after the original entrance spacer. It borrows the game's actual
heading, name and role fonts and colours. Original credit entries, their ordering
and slot layout are retained; a failed insertion attempts to restore all originals.
This is a client DLL feature and does not require a world-server change.

## Contributor audit

Audited on 2026-10-04 using complete (non-shallow) Git histories, including
`Co-authored-by` trailers. Sources:

- [Undaunted fork](https://github.com/Harmonicrain/Undaunted): `1.12`
  at `4866bc4a7a949965707c1c005c479efa8aa185a5`, and `1.4.4`
  at `bdd8a7b84eae429e51ac77a432a9cfe6928a8c80`.
- [Original Undaunted](https://github.com/SyST3MDeV/Undaunted): `main`
  at `7f692aa8157b93c09ebee12210962692aa369f03` (included in the fork's history).
- [Mystic Paradox](https://github.com/pranav158/Mystic-Paradox): `main`
  at `da317fbd30c0a0285e4e30ed4bb9bb812e618d3e`.

Every distinct recorded author/co-author is documented below. The displayed
credits omit Copilot at the owner's request, as described below. AI contributors
that are displayed are explicitly identified as assistance. Git committer identities are not used
as a substitute for authorship. Roles describe the source project; they do not
claim that every historical contributor worked on this fork's new features.

| Contributor | Recorded identities | Basis for merging |
| --- | --- | --- |
| Harmonicrain | Harmonic | Fork owner attribution, approved by owner |
| gwog / SyST3MDeV | Gregory Morford | GitHub author identity and `NOTICE.md` |
| Pranav Karande | Mystic, pranav158 | GitHub author identity and `NOTICE.md` |
| EisigesEis | Eisiges Eis, EisigesEis | Shared author identity and GitHub handle |
| Claude | Claude Opus 5, Claude Opus 5.5, Claude Sonnet 5.5 | Co-author trailers; same AI assistant family |
| GitHub Copilot | copilot-swe-agent[bot] | GitHub author identity (`Copilot`); AI agent |

### AI assistance on this fork

The owner explicitly requested credit for **Claude Opus 5.5**, **GPT Astra 6.1**,
and **GPT Sol 5.6 and 6.1** used on this codebase. They appear in a separate,
centred attribution headed `AI assistance on this fork`, below the four human
developer rows and above the provenance notices. This attribution uses the
smaller notice font size (two thirds of the role font, clamped to 16-24 points),
and wraps if needed. These model-specific credits are owner-provided
attribution, rather than a claim that all those models have Git author entries.
The historical Claude co-author identities above remain grouped as Claude;
the displayed model credit follows the owner's requested wording.

The original Undaunted history has no recorded Claude/GPT/Codex author or
co-author entries. Copilot has recorded author entries in Mystic Paradox, but
the owner reports that it was used for commit messages and requested its removal
from the displayed credits. This audit retains the metadata for provenance;
the in-game section contains no Copilot row.

Names are compiled into `UndauntedRuntime-1.12/client/CreditsContent.h`.
When refreshing the list, obtain complete histories from both projects, inspect
`git log --all --format='%aN'` and the co-author trailers, and merge aliases only
where identity evidence exists. Do not put email addresses into the UI or this
document. Keep the required Mystic Paradox attribution notice verbatim.

## Local testing

The insertion transaction has a native policy test covering entrance placement,
retained layout/order, duplicate prevention, missing anchors and rollback at every
append step. In-game validation must also check that the new heading enters from
below, all contributor rows appear, Phoenix Labs follows, and reopening Credits
does not duplicate the section. Stage the runtime in an isolated client directory
for this test; do not publish the launcher or update feed until approved.
