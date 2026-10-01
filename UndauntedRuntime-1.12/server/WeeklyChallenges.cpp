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
 * Hunt Pass selector. In October 2026 this file was split out of
 * client/Challenges.cpp. Not an official release of
 * Mystic Paradox or Undaunted.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#include "server/WeeklyChallenges.h"
#include "core/Logging.h"
#include "core/Memory.h"
#include "core/Transport.h"
#include <set>

// World servers give each weekly challenge component's table only the rows the
// metagame selected for this week (/game_tuning/bounty_game_data_weekly).

static INIT_ONCE g_WeeklyChallengeRowsOnce = INIT_ONCE_STATIC_INIT;

static std::set<std::string> g_WeeklyChallengeRows;

static SRWLOCK g_WeeklyChallengeTablesLock = SRWLOCK_INIT;

static std::set<UDataTable*> g_PatchedWeeklyChallengeTables;

static BOOL CALLBACK LoadWeeklyChallengeRows(PINIT_ONCE, PVOID, PVOID*) {
    const std::string Body = HttpGetFromMetagame(L"/game_tuning/bounty_game_data_weekly");
    const std::string Key = "\"bounty_id\":\"";
    for (size_t At = Body.find(Key); At != std::string::npos; At = Body.find(Key, At)) {
        At += Key.size();
        const size_t End = Body.find('"', At);
        if (End == std::string::npos) break;
        const std::string Id = Body.substr(At, End - At);
        if (Id.rfind("Challenge_Season_", 0) == 0 && Id.size() < 128
            && Id.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_") == std::string::npos)
            g_WeeklyChallengeRows.insert(Id);
        At = End + 1;
    }
    MpLog("[WeeklyChallenges] backend selected rows=" + std::to_string(g_WeeklyChallengeRows.size()));
    return TRUE;
}

void PatchWeeklyChallengeTable(UBountyComponent_Weekly* Component) {
    if (!Component || !IsReadablePointer(Component, sizeof(UBountyComponent_Weekly))) return;
    InitOnceExecuteOnce(&g_WeeklyChallengeRowsOnce, LoadWeeklyChallengeRows, nullptr, nullptr);
    if (g_WeeklyChallengeRows.empty()) return;
    auto* Table = Component->BountyTable;
    if (!Table || !IsReadablePointer(Table, sizeof(UDataTable))) return;

    AcquireSRWLockExclusive(&g_WeeklyChallengeTablesLock);
    if (g_PatchedWeeklyChallengeTables.count(Table) != 0) {
        ReleaseSRWLockExclusive(&g_WeeklyChallengeTablesLock);
        return;
    }

    FChallengeWeeklyData Template{};
    bool HasTemplate = false;
    for (auto& Pair : Table->RowMap) {
        const std::string Id = Pair.Key().GetRawString();
        if (Id.rfind("Challenge_Season_", 0) != 0) continue;
        auto* Row = reinterpret_cast<FBountyTableData*>(Pair.Value());
        if (!Row || !IsReadablePointer(Row, sizeof(FBountyTableData))) continue;
        for (const auto& Weekly : Row->HuntPassSeasonsData) {
            const std::string Season = Weekly.TargetHuntPassSeason.RowName.GetRawString();
            if (Weekly.WeekId == 0 && Season.find("19") != std::string::npos) {
                Template = Weekly;
                HasTemplate = true;
                break;
            }
        }
        if (HasTemplate) break;
    }
    if (!HasTemplate) {
        ReleaseSRWLockExclusive(&g_WeeklyChallengeTablesLock);
        MpLog("[WeeklyChallenges] table patch skipped: Season 19 week-zero template missing");
        return;
    }

    // SDK TArray::Add does not grow arrays. Prepare every replacement before
    // changing the table, using the engine allocator and independently owned tags.
    std::map<FBountyTableData*, TArray<FChallengeWeeklyData>> Replacements;
    auto CopyTags = [](const TArray<FGameplayTag>& Source) {
        if (Source.Num() == 0) return TArray<FGameplayTag>{};
        auto* Data = static_cast<FGameplayTag*>(EngineRealloc(nullptr, Source.Num() * sizeof(FGameplayTag)));
        if (!Data) return TArray<FGameplayTag>{};
        memcpy(Data, Source.GetDataPtr(), Source.Num() * sizeof(FGameplayTag));
        return TArray<FGameplayTag>(Data, Source.Num(), Source.Num());
    };
    for (auto& Pair : Table->RowMap) {
        if (g_WeeklyChallengeRows.count(Pair.Key().GetRawString()) == 0) continue;
        auto* Row = reinterpret_cast<FBountyTableData*>(Pair.Value());
        if (!Row || !IsReadablePointer(Row, sizeof(FBountyTableData))) continue;
        auto* Data = static_cast<FChallengeWeeklyData*>(EngineRealloc(nullptr, sizeof(FChallengeWeeklyData)));
        if (!Data) continue;
        *Data = Template;
        Data->Tags.GameplayTags = CopyTags(Template.Tags.GameplayTags);
        Data->Tags.ParentTags = CopyTags(Template.Tags.ParentTags);
        if (Data->Tags.GameplayTags.Num() != Template.Tags.GameplayTags.Num()
            || Data->Tags.ParentTags.Num() != Template.Tags.ParentTags.Num()) {
            EngineRealloc(const_cast<FGameplayTag*>(Data->Tags.GameplayTags.GetDataPtr()), 0);
            EngineRealloc(const_cast<FGameplayTag*>(Data->Tags.ParentTags.GetDataPtr()), 0);
            EngineRealloc(Data, 0);
            continue;
        }
        Replacements.emplace(Row, TArray<FChallengeWeeklyData>(Data, 1, 1));
    }
    if (Replacements.size() != 10 || g_WeeklyChallengeRows.size() != 10) {
        for (auto& Pair : Replacements) {
            auto& Data = Pair.second[0];
            EngineRealloc(const_cast<FGameplayTag*>(Data.Tags.GameplayTags.GetDataPtr()), 0);
            EngineRealloc(const_cast<FGameplayTag*>(Data.Tags.ParentTags.GetDataPtr()), 0);
            EngineRealloc(const_cast<FChallengeWeeklyData*>(Pair.second.GetDataPtr()), 0);
        }
        ReleaseSRWLockExclusive(&g_WeeklyChallengeTablesLock);
        MpLog("[WeeklyChallenges] refusing incomplete replacement; original table retained");
        return;
    }
    int Selected = 0, Cleared = 0;
    for (auto& Pair : Table->RowMap) {
        const std::string Id = Pair.Key().GetRawString();
        if (Id.rfind("Challenge_Season_", 0) != 0) continue;
        auto* Row = reinterpret_cast<FBountyTableData*>(Pair.Value());
        if (!Row || !IsReadablePointer(Row, sizeof(FBountyTableData))) continue;
        for (auto& Old : Row->HuntPassSeasonsData) {
            EngineRealloc(const_cast<FGameplayTag*>(Old.Tags.GameplayTags.GetDataPtr()), 0);
            EngineRealloc(const_cast<FGameplayTag*>(Old.Tags.ParentTags.GetDataPtr()), 0);
        }
        EngineRealloc(const_cast<FChallengeWeeklyData*>(Row->HuntPassSeasonsData.GetDataPtr()), 0);
        const auto Replacement = Replacements.find(Row);
        if (Replacement != Replacements.end()) {
            Row->HuntPassSeasonsData = Replacement->second;
            ++Selected;
        } else {
            Row->HuntPassSeasonsData = {};
            ++Cleared;
        }
    }
    g_PatchedWeeklyChallengeTables.insert(Table);
    ReleaseSRWLockExclusive(&g_WeeklyChallengeTablesLock);
    MpLog("[WeeklyChallenges] patched table selected=" + std::to_string(Selected)
        + " cleared=" + std::to_string(Cleared));
}
