# UndauntedRuntime-1.12: provenance

This directory is the injected runtime for the Dauntless **1.12.0** client
(`rel-1.12.0-Archon`, changelist 392819, Unreal Engine 4.26.2). It is imported
from Mystic Paradox and is being adapted for this fork. The 1.4.4 runtime in
`UndauntedInternalServer/` is unchanged and still serves the 1.4.4 client.

## Source

- Project: Mystic Paradox, `ParadoxRuntime/`
- Repository: https://github.com/pranav158/Mystic-Paradox
- Commit: `355934c9018f2aab9f9013baeb6588d1f4894532` (2026-08-09)
- Copyright (C) 2026 MysticFox / Pranav Karande, itself a modified version of
  Undaunted, Copyright (C) 2026 gwog :3 (SyST3MDeV)
- License: AGPL-3.0-only, with the additional terms under AGPLv3 Section 7 in
  the repository root `ADDITIONAL_TERMS.md`

Required attribution notice (ADDITIONAL_TERMS.md, term 1):

> "Mystic Paradox's Dauntless 1.12.0 port and related modifications were
> developed by Pranav Karande. See NOTICE.md for contribution
> and provenance information."

`MinHook/` is MinHook by Tsuda Kageyu (BSD 2-Clause); its license text is kept
in each source file header.

## State at import

Every file was exported unchanged from the commit above with `git archive`.
The only addition at import time is the ignore block at the end of
`.gitignore` for the generated SDK and the per-host configuration header.
Later changes for this fork are recorded in the commit history, and each
modified file's header says that it was modified here, as AGPLv3 Section 5
and the additional terms require. This is not an official release of Mystic
Paradox or of Undaunted.

## Not included: generate these yourself

- **SDK.** Build [Dumper-7](https://github.com/Encryqed/Dumper-7), inject it
  into your own running 1.12.0 client, and copy the complete `CppSDK` output
  (`SDK/`, `SDK.hpp`, `Assertions.inl`, `NameCollisions.inl`,
  `PropertyFixup.hpp`, `UnrealContainers.hpp`, `UtfN.hpp`) into this
  directory. The SDK is game-derived and is ignored by git.
- **`deployment_config.generated.h`.** Copy it from
  `deployment_config.generated.h.example` and set the backend host.
