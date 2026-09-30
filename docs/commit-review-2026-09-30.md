# Local commit review: 30 September 2026

The changes were sliced on `port-1.12`, starting after
`06919a10b1aff127e7aaa017339fedfa65da1114`. Nothing has been pushed. Review the
entire sequence before any push. Existing earlier commits were left intact.

Gameplay fixes come first, then organization and cleanup, then build tooling,
documentation and the checked launcher DLL. Moves are separate from rule
extraction so their diffs remain readable. Every code slice was validated
before it was committed using a private index and build directory.

| Order | Commit | Change | Validation |
| --- | --- | --- | --- |
| 1 | `b3ab501` | fix(middleman): restore Aetherdust exchanges | Metagame compiled; 244 tests passed; Release/x64 runtime built with v143 |
| 2 | `6a0de20` | feat(challenges): add shared weekly rotation | Metagame compiled; 247 tests passed; Release/x64 runtime built |
| 3 | `f2d9d66` | fix(huntpass): restore archive reward tracks | Metagame compiled; 256 tests passed; Release/x64 runtime built |
| 4 | `a4ea120` | fix(loot): guard summary close transitions | Release/x64 runtime built; backend unchanged from 256 passing tests |
| 5 | `ea24829` | refactor(runtime): split hooks by feature | Release/x64 runtime built with extracted modules; backend unchanged from 256 passing tests |
| 6 | `5189a21` | refactor(metagame): group gameplay by feature | Metagame compiled; 256 tests passed after pure feature moves |
| 7 | `0b8555f` | refactor(metagame): isolate transaction rules | Metagame compiled; 256 tests passed after transaction/store extraction |
| 8 | `e7e009b` | refactor(startup): centralize config and resets | Metagame compiled; 259 tests passed including explicit startup and UTC reset boundaries |
| 9 | `847d15d` | chore(types): reject unused backend code | Both TypeScript packages compiled with unused checks; metagame 259 passed; deploy 3 passed and 1 fixture-dependent skip |
| 10 | `c3abfbb` | build(1.12): add checked local build workflow | PowerShell syntax parsed; installed 1.12 executable matches pin; equivalent workflow previously built/tested/deployed successfully |
| 11 | `f009082` | Architecture map, cleanup report and this review guide | Paths and whitespace checked |
| 12 | DLL activation fix | Wait for writable DLLs and retry racing copy locks | Mapped-image reproduction and both retry scenarios passed |
| 13 | Final artifact slice | Checked launcher DLL and source/build record | Clean build, backend tests, matching installed hashes and restart |

## Review commands

Run these in the repository:

```powershell
git log --reverse --oneline 06919a10..HEAD
git show --stat <commit>
git show --find-renames <commit>
git diff --check 06919a10 HEAD
```

Use the hashes above for the first ten slices; the final three appear in the
ordered log. The source identity in `build-112-2026-09-30.json` points at the
DLL activation fix immediately before the DLL refresh, avoiding a circular
reference to the binary commit itself.

## Scope and preservation

- The first commit includes the weekly selector used by Middleman offers; the
  next commit wires its challenge board, tuning and UI.
- Native feature definitions were reconstructed from the saved pre-refactor
  snapshot, then compiled before the module extraction was committed.
- Generated SDK inputs, private environment files, account databases, logs and
  temporary build outputs are excluded from these commits.
- Existing party and HUD behavior is preserved through the module moves.
- The running game was left alone during slicing; activation of the final
  checked build stops and restarts the local stack with permission.
- The source snapshot is preserved under
  `E:/Dauntless/backups/organization-20260929-232638` and the commit preparation
  and intermediate test logs under
  `E:/Dauntless/backups/commit-slices-20260930-004722`.

## Related reports

- [Architecture and build map](architecture-112.md)
- [Full cleanup report](cleanup-report-2026-09-30.md)

## DLL activation follow-up

The first post-commit deployment exposed a Windows image-mapping lock after
shutdown. A read-only exclusive open succeeded while the DLL image remained
mapped. The follow-up requires write access and retries a lock that appears
between the release check and the actual copy.

The local reproduction maps a disposable copy with `LoadLibraryEx` using
`DONT_RESOLVE_DLL_REFERENCES`, so the game DLL entry point never runs. Both
the release wait and a new mapping opened before the copy held replacement
until release (about 1.5 seconds), and the replacement hashes matched. The
probe is saved in the commit-preparation backup as `check-dll-replacement.ps1`.
