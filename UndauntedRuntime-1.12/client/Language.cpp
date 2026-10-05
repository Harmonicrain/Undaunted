/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

#include "client/Language.h"
#include "core/RuntimeState.h"
#include "core/Logging.h"
#include <atomic>
#include <cwctype>

// The 1.12.0 client ships text for eight languages (Content/Localization/Game)
// but starts in English whatever -culture= says: its Game.locmeta is the old
// format that lists only the native culture, so the engine's startup check
// finds no other localized culture and falls back to "en" (read from the
// running client's FInternationalization: current language "en" with
// -culture=fr on the command line). The engine's own culture switch, the same
// one the CULTURE= console command uses, loads a culture's text directly, so
// the launcher's choice is applied with it once the game is running.

namespace {
std::atomic<bool> Applied{ false };

// The value of -culture= on the command line, if it is a plausible culture
// name ("fr", "pt-BR"); empty otherwise.
std::wstring RequestedCulture() {
    const wchar_t* Line = GetCommandLineW();
    static const wchar_t Key[] = L"-culture=";
    for (const wchar_t* At = Line; (At = wcsstr(At, L"-")) != nullptr; ++At) {
        if (At != Line && !iswspace(At[-1])) continue;
        if (_wcsnicmp(At, Key, wcslen(Key)) != 0) continue;
        std::wstring Value;
        for (const wchar_t* Char = At + wcslen(Key); *Char && !iswspace(*Char); ++Char) Value += *Char;
        if (Value.size() < 2 || Value.size() > 8) return L"";
        for (wchar_t Char : Value) {
            if (!iswalpha(Char) && Char != L'-' && Char != L'_') return L"";
        }
        return Value;
    }
    return L"";
}
}

void ApplyRequestedCultureOnce() {
    if (Applied.exchange(true)) return;
    const std::wstring Requested = RequestedCulture();
    if (Requested.empty()) return;
    const std::string Name = MpNarrow(Requested);
    const std::string Before = SDK::UKismetInternationalizationLibrary::GetCurrentCulture().ToString();
    if (_stricmp(Before.c_str(), Name.c_str()) == 0) {
        MpLog("[Language] -culture=" + Name + ": the engine already started in " + Before);
        return;
    }
    const bool Ok = SDK::UKismetInternationalizationLibrary::SetCurrentCulture(SDK::FString(Requested.c_str()), false);
    MpLog("[Language] -culture=" + Name + ": the engine started in " + Before + "; SetCurrentCulture "
        + (Ok ? "succeeded" : "failed") + ", now " + SDK::UKismetInternationalizationLibrary::GetCurrentCulture().ToString());
}
