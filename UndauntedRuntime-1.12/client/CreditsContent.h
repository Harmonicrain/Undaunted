/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
#pragma once
#include <array>

namespace PrivateServerCredits {
inline constexpr wchar_t Heading[] = L"Undaunted Private Server Credits";
inline constexpr wchar_t Subheading[] = L"Private Server Development";

struct Contributor { const wchar_t* Name; const wchar_t* Role; };
// Git authors/co-authors plus the owner's attribution of AI used on this fork.
// See docs/private-server-credits-112.md for the separate attribution sources.
inline constexpr std::array<Contributor, 4> Contributors{{
    {L"Harmonicrain", L"Undaunted private server fork"},
    {L"gwog / SyST3MDeV", L"Original Undaunted server"},
    {L"Pranav Karande", L"Dauntless 1.12 port"},
    {L"EisigesEis", L"Undaunted contributor"},
}};
inline constexpr wchar_t AiHeading[] = L"AI assistance on this fork";
inline constexpr wchar_t AiModels[] =
    L"Claude Opus 5.5 | GPT Astra 6.1 | GPT Sol 5.6 and 6.1";
inline constexpr wchar_t Attribution[] =
    L"Mystic Paradox's Dauntless 1.12.0 port and related modifications were "
    L"developed by Pranav Karande. See NOTICE.md for contribution "
    L"and provenance information.";
inline constexpr wchar_t ModificationNotice[] =
    L"Modified community version. Not an official release of Undaunted or Mystic Paradox.";
}
