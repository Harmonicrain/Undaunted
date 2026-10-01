/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

#include "core/Settings.h"
#include "core/SettingsParse.h"
#include "core/Logging.h"

// The settings replace 26 flag files that sat next to the executable or in a
// debug folder (removed 2026-10-01): diagnostics are now -UndauntedDiag
// channels, and the experiments and kill switches no one used are gone.

namespace {
const std::vector<UndauntedSwitch>& Switches() {
    static const std::vector<UndauntedSwitch> Parsed = ParseUndauntedSwitches(GetCommandLineW());
    return Parsed;
}
}

namespace Settings {
    bool Has(const wchar_t* Name) {
        return FindUndauntedSwitch(Switches(), Name) != nullptr;
    }

    int Int(const wchar_t* Name, int Absent, int Min, int Max, int Invalid) {
        return UndauntedSwitchInt(Switches(), Name, Absent, Min, Max, Invalid);
    }

    std::wstring Text(const wchar_t* Name) {
        const UndauntedSwitch* Switch = FindUndauntedSwitch(Switches(), Name);
        return Switch ? Switch->Value : std::wstring();
    }

    bool Diag(const wchar_t* Channel) {
        static const std::wstring Channels = Text(L"Diag");
        return !Channels.empty() && UndauntedListHas(Channels, Channel);
    }

    void LogActive() {
        std::string Line;
        for (const UndauntedSwitch& Switch : Switches()) {
            Line += " -Undaunted" + MpNarrow(Switch.Name);
            if (Switch.HasValue) Line += "=" + MpNarrow(Switch.Value);
        }
        MpLog("[Settings]" + (Line.empty() ? std::string(" (none)") : Line));
    }
}
