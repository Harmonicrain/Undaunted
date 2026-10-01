/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Further modified in September 2026 for the Undaunted fork (Harmonicrain/Undaunted):
 * the backend address comes from the command line and requests go to the
 * Undaunted metagame over plain HTTP/WebSocket; the PlayerController
 * pre-channel guard reads ReplicateSingleActor's arguments in the executable's
 * order; the client skips the legendary-ability HUD's weapon update until a
 * weapon is equipped; the seasonal event feature flags the metagame lists are
 * forced on; world servers answer event schedule checks from the metagame's
 * seasonal event schedule; validated archive passes can be shown by the native
 * Hunt Pass selector. Not an official release of
 * Mystic Paradox or Undaunted.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#include "core/RuntimeHooks.h"
#include "core/RuntimeState.h"
#include "native/Addresses112.h"
#include "core/Logging.h"

void InstallApiHook(LPCWSTR Module, LPCSTR ProcName, LPVOID Detour, LPVOID* Original, const char* Tag) {
    LPVOID Target = nullptr;
    MH_STATUS CreateStatus = MH_CreateHookApiEx(Module, ProcName, Detour, Original, &Target);
    MH_STATUS EnableStatus = CreateStatus == MH_OK ? RuntimeHooks::Enable(Target) : CreateStatus;

    MpLog("[ExitTrace] hook " + std::string(Tag)
        + " create=" + MH_StatusToString(CreateStatus)
        + " enable=" + MH_StatusToString(EnableStatus)
        + " target=" + MpPtr(Target));
}

namespace RuntimeHooks {
    MH_STATUS Create(void* Target, void* Detour, void** Original, const char* Name) {
        const MH_STATUS Status = MH_CreateHook(Target, Detour, Original);
        MpLog(std::string("[Hooks] create ") + Name + " target=" + MpAddress(Target)
            + " status=" + MH_StatusToString(Status));
        return Status;
    }

    MH_STATUS Enable(void* Target) {
        const MH_STATUS Status = MH_EnableHook(Target);
        MpLog("[Hooks] enable target=" + MpAddress(Target)
            + " status=" + MH_StatusToString(Status));
        return Status;
    }

    MH_STATUS Install(uintptr_t Rva, void* Detour, void** Original, const char* Name) {
        void* Target = reinterpret_cast<void*>(Native112::At(Globals::BaseAddress, Rva));
        const MH_STATUS Created = MH_CreateHook(Target, Detour, Original);
        const MH_STATUS Enabled = Created == MH_OK ? MH_EnableHook(Target) : Created;
        MpLog(std::string("[Hooks] ") + Name + " +" + MpHex(Rva) + (Enabled == MH_OK ? " installed"
            : std::string(" FAILED create=") + MH_StatusToString(Created) + " enable=" + MH_StatusToString(Enabled)));
        return Enabled;
    }
}
