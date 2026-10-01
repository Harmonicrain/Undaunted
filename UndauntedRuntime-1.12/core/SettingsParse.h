/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
#pragma once
#include <cstdlib>
#include <cwchar>
#include <cwctype>
#include <string>
#include <vector>

// The runtime's -Undaunted switches, parsed from a command line without
// Windows calls so the rules can be tested natively (test/settings.test.cpp).

struct UndauntedSwitch {
    std::wstring Name;   // after "-Undaunted", e.g. L"ServerFPS"
    std::wstring Value;  // after the first '=', empty without one
    bool HasValue = false;
};

inline bool SettingsNameEquals(const std::wstring& A, const wchar_t* B) {
    size_t i = 0;
    for (; i < A.size() && B[i]; ++i) {
        if (std::towlower(A[i]) != std::towlower(B[i])) return false;
    }
    return i == A.size() && !B[i];
}

// Splits on spaces and tabs outside double quotes (the quotes are dropped) and
// keeps the arguments that start with -Undaunted, in any case.
inline std::vector<UndauntedSwitch> ParseUndauntedSwitches(const wchar_t* CommandLine) {
    std::vector<UndauntedSwitch> Switches;
    if (!CommandLine) return Switches;
    static const wchar_t Prefix[] = L"-undaunted";
    const size_t PrefixLength = sizeof(Prefix) / sizeof(Prefix[0]) - 1;
    std::wstring Token;
    auto Flush = [&] {
        bool HasPrefix = Token.size() > PrefixLength;
        for (size_t i = 0; HasPrefix && i < PrefixLength; ++i) {
            HasPrefix = std::towlower(Token[i]) == Prefix[i];
        }
        if (HasPrefix) {
            UndauntedSwitch Switch;
            const size_t Equals = Token.find(L'=', PrefixLength);
            Switch.Name = Token.substr(PrefixLength, Equals == std::wstring::npos ? std::wstring::npos : Equals - PrefixLength);
            if (Equals != std::wstring::npos) {
                Switch.Value = Token.substr(Equals + 1);
                Switch.HasValue = true;
            }
            if (!Switch.Name.empty()) Switches.push_back(Switch);
        }
        Token.clear();
    };
    bool InQuotes = false;
    for (const wchar_t* p = CommandLine; *p; ++p) {
        if (*p == L'"') { InQuotes = !InQuotes; continue; }
        if (!InQuotes && (*p == L' ' || *p == L'\t')) { Flush(); continue; }
        Token += *p;
    }
    Flush();
    return Switches;
}

// The first switch with this name (without "-Undaunted"), in any case.
inline const UndauntedSwitch* FindUndauntedSwitch(const std::vector<UndauntedSwitch>& Switches, const wchar_t* Name) {
    for (const UndauntedSwitch& Switch : Switches) {
        if (SettingsNameEquals(Switch.Name, Name)) return &Switch;
    }
    return nullptr;
}

// A whole-number value in [Min, Max]: Absent without the switch, Invalid when
// its value is missing, not a number or out of range.
inline int UndauntedSwitchInt(const std::vector<UndauntedSwitch>& Switches, const wchar_t* Name,
    int Absent, int Min, int Max, int Invalid) {
    const UndauntedSwitch* Switch = FindUndauntedSwitch(Switches, Name);
    if (!Switch) return Absent;
    if (Switch->Value.empty()) return Invalid;
    wchar_t* End = nullptr;
    const long long Value = std::wcstoll(Switch->Value.c_str(), &End, 10);
    if (!End || *End != L'\0' || Value < Min || Value > Max) return Invalid;
    return static_cast<int>(Value);
}

// Whether a comma-separated list such as L"repgraph,bleedout" names Item, in any case.
inline bool UndauntedListHas(const std::wstring& List, const wchar_t* Item) {
    size_t Start = 0;
    while (Start <= List.size()) {
        size_t Comma = List.find(L',', Start);
        if (Comma == std::wstring::npos) Comma = List.size();
        if (SettingsNameEquals(List.substr(Start, Comma - Start), Item)) return true;
        Start = Comma + 1;
    }
    return false;
}
