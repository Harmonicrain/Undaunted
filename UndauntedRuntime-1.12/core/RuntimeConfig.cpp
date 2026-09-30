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

#include "core/RuntimeConfig.h"

bool MpExeRelativeFlagPresent(const wchar_t* FileName) {
    if (!FileName) return false;
    wchar_t ExePath[MAX_PATH];
    DWORD n = GetModuleFileNameW(nullptr, ExePath, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) return false;
    for (int i = static_cast<int>(n) - 1; i >= 0; --i) {
        if (ExePath[i] == L'\\' || ExePath[i] == L'/') {
            ExePath[i + 1] = L'\0';
            break;
        }
    }
    const std::wstring FlagPath = std::wstring(ExePath) + FileName;
    return GetFileAttributesW(FlagPath.c_str()) != INVALID_FILE_ATTRIBUTES;
}

bool MpWorkingDirectoryFlagPresent(const wchar_t* FileName) {
    return FileName && GetFileAttributesW(FileName) != INVALID_FILE_ATTRIBUTES;
}

bool VerboseDiag() {
    static const bool Enabled = MpExeRelativeFlagPresent(L"VERBOSE_DIAG.flag");
    return Enabled;
}
