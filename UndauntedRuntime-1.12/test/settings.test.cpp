/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
#include "../core/SettingsParse.h"
#include <cassert>

int main() {
    // A world server's command line: positional arguments, then switches.
    const auto World = ParseUndauntedSwitches(
        L"\"C:\\Game Dir\\Dauntless-Win64-Shipping.exe\" KEY 8787 /Game/Maps/x NO_BEHEMOTH NO_MM_HUNTID "
        L"NO_EXPECTED_PLAYERS 127.0.0.1:8787 127.0.0.1:61000 -EpicPortal -server -nullrhi "
        L"-UndauntedServerFPS=30 -undauntedafktimeoutseconds=1200 -UndauntedServerTickFilter "
        L"-UndauntedDiag=repgraph,Bleedout");
    assert(World.size() == 4);
    assert(World[0].Name == L"ServerFPS" && World[0].Value == L"30" && World[0].HasValue);
    assert(World[2].Name == L"ServerTickFilter" && !World[2].HasValue);

    // Names match whole, in any case; the first of a repeated switch wins.
    assert(FindUndauntedSwitch(World, L"servertickfilter"));
    assert(!FindUndauntedSwitch(World, L"ServerTick"));
    assert(!FindUndauntedSwitch(World, L"ServerTickFilterCensus"));
    const auto Repeated = ParseUndauntedSwitches(L"x -UndauntedServerFPS=60 -UndauntedServerFPS=30");
    assert(UndauntedSwitchInt(Repeated, L"ServerFPS", 90, 1, 240, 90) == 60);

    // Numbers: absent, valid, out of range, not a number, missing.
    assert(UndauntedSwitchInt(World, L"ServerFPS", 90, 1, 240, 90) == 30);
    assert(UndauntedSwitchInt(World, L"IdleFPS", 10, 1, 240, 10) == 10);
    assert(UndauntedSwitchInt(World, L"AfkTimeoutSeconds", -1, 0, 604800, -1) == 1200);
    const auto Bad = ParseUndauntedSwitches(L"-UndauntedServerFPS=999 -UndauntedTrimSeconds=abc -UndauntedFrameSlackUs= -UndauntedIdleFPS");
    assert(UndauntedSwitchInt(Bad, L"ServerFPS", 90, 1, 240, 7) == 7);
    assert(UndauntedSwitchInt(Bad, L"TrimSeconds", 0, 0, 86400, 5) == 5);
    assert(UndauntedSwitchInt(Bad, L"FrameSlackUs", 500, 0, 2000, 3) == 3);
    assert(UndauntedSwitchInt(Bad, L"IdleFPS", 10, 1, 240, 4) == 4);

    // Quoted values keep their spaces; other arguments are ignored.
    const auto Quoted = ParseUndauntedSwitches(L"-log \"-UndauntedMetagame=host name:61000\" -UndauntedX");
    assert(Quoted.size() == 2 && Quoted[0].Value == L"host name:61000");
    assert(ParseUndauntedSwitches(L"-Undaunted -Undaunted= -server").empty());
    assert(ParseUndauntedSwitches(nullptr).empty());

    // Diagnostic channel lists.
    assert(UndauntedListHas(World[3].Value, L"repgraph"));
    assert(UndauntedListHas(World[3].Value, L"bleedout"));
    assert(!UndauntedListHas(World[3].Value, L"bleed"));
    assert(!UndauntedListHas(L"", L"repgraph"));
    assert(UndauntedListHas(L"a,,b", L"b"));
    return 0;
}
