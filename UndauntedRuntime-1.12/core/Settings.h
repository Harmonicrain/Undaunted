/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

#pragma once
#include "core/Runtime.h"

// The runtime's settings: -Undaunted switches on the process command line,
// read once. World servers get theirs from GAMESERVER_EXTRA_ARGS in the deploy
// server's .env; a client from its launch arguments. The switches are listed in
// docs/architecture-112.md. Names are given without "-Undaunted".
namespace Settings {
    // -Undaunted<Name> is present, with or without a value.
    bool Has(const wchar_t* Name);

    // -Undaunted<Name>=<n>: Absent without the switch, Invalid when the value
    // isn't a whole number in [Min, Max].
    int Int(const wchar_t* Name, int Absent, int Min, int Max, int Invalid);

    // -Undaunted<Name>=<text>, empty without the switch.
    std::wstring Text(const wchar_t* Name);

    // A diagnostic named in -UndauntedDiag=<a,b,...> (off unless listed).
    bool Diag(const wchar_t* Channel);

    // Logs the -Undaunted switches this process was given ([Settings]).
    void LogActive();
}
