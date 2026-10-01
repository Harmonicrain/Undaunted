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

#include "server/PlayerData.h"
#include "core/RuntimeState.h"
#include "native/Addresses112.h"
#include "core/Logging.h"
#include "core/Memory.h"
#include "server/ServerEvents.h"

static std::wstring ServerSharedPlayerHuntId();

void* OrigOnPlayerDataLoadComplete = nullptr;

static std::wstring ServerSharedPlayerHuntId() {
    if (!Globals::ExpectedPlayerString) return L"";
    std::wstring S(Globals::ExpectedPlayerString);
    size_t Colon = S.find(L':');
    if (Colon == std::wstring::npos) return L"";
    size_t Start = Colon + 1;
    size_t Comma = S.find(L',', Start);
    return S.substr(Start, Comma == std::wstring::npos ? std::wstring::npos : Comma - Start);
}

void OnPlayerDataLoadCompleteHook(UObject* PC, bool bWasSuccessful) {

    reinterpret_cast<void(*)(UObject*, bool)>(OrigOnPlayerDataLoadComplete)(PC, bWasSuccessful);

    if (!bWasSuccessful) return;

    if (!PC || !IsReadablePointer(PC, 0x770)) return;

    UObject* HuntSystem = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(PC) + 0x768);
    if (!HuntSystem || !IsReadablePointer(HuntSystem, 0x190)) return;

    int32_t HuntIdLen = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(HuntSystem) + 0x188);
    if (HuntIdLen >= 2) return;

    std::wstring HuntId = ServerSharedPlayerHuntId();
    if (HuntId.empty()) {
        MpLog("[HuntIdBackfill] PlayerHuntId empty but no hunt id in ExpectedPlayerString; skipping");
        return;
    }

    static UFunction* s_DebugSetPlayerHuntIDFn = nullptr;
    if (!s_DebugSetPlayerHuntIDFn) {
        s_DebugSetPlayerHuntIDFn = HuntSystem->Class->GetFunction("HuntSystemComponent", "DebugSetPlayerHuntID");
        MpLog(std::string("[HuntIdBackfill] resolve DebugSetPlayerHuntID -> ") + MpPtr(s_DebugSetPlayerHuntIDFn));
    }
    if (!s_DebugSetPlayerHuntIDFn) return;

    struct { FString HuntID; } Parms{ FString(HuntId.c_str()) };
    reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEvent)(HuntSystem, s_DebugSetPlayerHuntIDFn, &Parms);
    MpLog("[HuntIdBackfill] PlayerHuntId was empty -> set '" + MpNarrow(HuntId) + "'");
}
