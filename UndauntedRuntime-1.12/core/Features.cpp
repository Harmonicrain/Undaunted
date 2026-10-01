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
#include "core/Features.h"
#include <unordered_map>
#include "core/RuntimeState.h"
#include "native/Addresses112.h"
#include "core/Logging.h"
#include "core/Memory.h"
#include "core/Transport.h"

using FeatureFlagIsEnabledFn = bool(__fastcall*)(void* This);

using IsScheduledItemActiveFn = bool(__fastcall*)(void* WorldContext, uint64_t Id, int64_t NowTicks);

struct FMetagameScheduleRow { std::string Name; int64_t StartTicks; int64_t EndTicks; };

static void LoadForcedFeatureFlags();
static BOOL CALLBACK LoadForcedFeatureFlagsOnce(PINIT_ONCE, PVOID, PVOID*);
static bool __fastcall FeatureFlagIsEnabledHook(void* This);
static int64_t IsoUtcToTicks(const std::string& Iso);
static std::string JsonStringField(const std::string& Json, const char* Key);
static void LoadMetagameSchedule();
static BOOL CALLBACK LoadMetagameScheduleOnce(PINIT_ONCE, PVOID, PVOID*);
static bool __fastcall IsScheduledItemActiveHook(void* WorldContext, uint64_t Id, int64_t NowTicks);
static int TrialsRotationMinutes();
static int TrialsLaunchWeekOverride();
static bool TryParseTrialsScheduleWeek(const std::string& RowName, int& WeekOut);
static std::string TrialsScheduleRowName(int Week);
static void PatchArenaScheduleForCurrentTime(void* tablesArr);

// UFeatureFlag::IsEnabled() const: RVA Native112::FeatureFlagIsEnabled in 1.12.0, slot +0x270 of
// UFeatureFlag's vtable (RVA 0x04EEAB88). Every feature-flag check ends here:
// UFeatureFlagBlueprintLibrary::IsFeatureEnabled (0x00E57DA0; party overrides
// are applied on top of this result) and IsLocalFeatureEnabled (0x00E58120)
// take the flag class's default object and call it, as do native callers.
//
// Some content is behind flags baked off in the paks. Ramsgate's persistent
// level streams in its seasonal event levels only when their flags are on:
// city_01_event_dark_harvest (the decorations and the Unseen, who gives the
// event's quests) with city_event_dark_harvest_bpff, city_01_event_stall (Ozz,
// the event vendor) with city_event_stall_bpff. The metagame lists the flags of
// the events it is running (GET /undaunted/feature_flags); the client and the
// gameserver each ask once, on their first flag check, and those flags then
// read as enabled. With no metagame address, or no answer, nothing is forced.
//
// Win32 INIT_ONCE and SRWLOCK, not std::call_once / std::mutex: this DLL is
// built with a newer MSVC than the MSVCP140.dll the game loads, and the
// standard library's locks crashed inside that older runtime (seen on the
// gameserver: access violation in MSVCP140.dll on the first flag check).
static constexpr uintptr_t kFeatureFlagIsEnabledRva = Native112::FeatureFlagIsEnabled;

static FeatureFlagIsEnabledFn OrigFeatureFlagIsEnabled = nullptr;

static INIT_ONCE g_ForcedFeatureFlagsOnce = INIT_ONCE_STATIC_INIT;

static std::set<std::string> g_ForcedFeatureFlags;

// flag class names without "_C"
static SRWLOCK g_FeatureFlagLogLock = SRWLOCK_INIT;

static std::set<std::string> g_LoggedFeatureFlags;

// {"payload":{"enabled":["city_event_dark_harvest_bpff", ...]}}
static void LoadForcedFeatureFlags() {
    if (Globals::MetagameAddress.empty()) {
        MpLog("[FeatureFlags] no metagame address; no flags forced");
        return;
    }
    const std::string Body = HttpGetFromMetagame(L"/undaunted/feature_flags");
    const size_t Key = Body.find("\"enabled\"");
    const size_t Open = Key == std::string::npos ? std::string::npos : Body.find('[', Key);
    const size_t Close = Open == std::string::npos ? std::string::npos : Body.find(']', Open);
    if (Close == std::string::npos) {
        MpLog("[FeatureFlags] no answer from the metagame (" + std::to_string(Body.size()) + " bytes); no flags forced");
        return;
    }
    std::string Forced;
    for (size_t At = Body.find('"', Open); At != std::string::npos && At < Close; ) {
        const size_t End = Body.find('"', At + 1);
        if (End == std::string::npos || End > Close) break;
        const std::string Name = Body.substr(At + 1, End - At - 1);
        if (!Name.empty()) {
            g_ForcedFeatureFlags.insert(Name);
            Forced += (Forced.empty() ? "" : ", ") + Name;
        }
        At = Body.find('"', End + 1);
    }
    MpLog("[FeatureFlags] forced on: " + (Forced.empty() ? std::string("none") : Forced));
}

static BOOL CALLBACK LoadForcedFeatureFlagsOnce(PINIT_ONCE, PVOID, PVOID*) {
    LoadForcedFeatureFlags();
    return TRUE;
}

// Each flag class's name is worked out once. Building it, checking pointers
// with VirtualQuery and taking the log lock on every flag check showed in a
// hunting ground's profile (2026-10-01). Keyed by class, checked against its
// FName in case freed memory is reused.
struct FeatureFlagDecision { int32_t NameIndex; uint32_t NameNumber; bool ForcedOff; bool InForcedSet; };
static SRWLOCK g_FeatureFlagDecisionLock = SRWLOCK_INIT;
static std::unordered_map<void*, FeatureFlagDecision> g_FeatureFlagDecisions;

static bool ReadFeatureFlagClass(void* This, SDK::UClass** Class, int32_t* NameIndex, uint32_t* NameNumber) {
    __try {
        *Class = reinterpret_cast<SDK::UObject*>(This)->Class;
        if (!*Class) return false;
        *NameIndex = (*Class)->Name.ComparisonIndex;
        *NameNumber = (*Class)->Name.Number;
        return true;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

static bool __fastcall FeatureFlagIsEnabledHook(void* This) {
    const bool Baked = OrigFeatureFlagIsEnabled(This);
    InitOnceExecuteOnce(&g_ForcedFeatureFlagsOnce, LoadForcedFeatureFlagsOnce, nullptr, nullptr);
    SDK::UClass* Class = nullptr;
    int32_t NameIndex = 0;
    uint32_t NameNumber = 0;
    if (!This || !ReadFeatureFlagClass(This, &Class, &NameIndex, &NameNumber)) return Baked;
    FeatureFlagDecision Decision{};
    bool Known = false;
    AcquireSRWLockShared(&g_FeatureFlagDecisionLock);
    const auto Found = g_FeatureFlagDecisions.find(Class);
    if (Found != g_FeatureFlagDecisions.end() && Found->second.NameIndex == NameIndex
        && Found->second.NameNumber == NameNumber) {
        Decision = Found->second;
        Known = true;
    }
    ReleaseSRWLockShared(&g_FeatureFlagDecisionLock);
    if (!Known) {
        std::string Name = Class->GetName();
        if (Name.size() > 2 && Name.compare(Name.size() - 2, 2, "_C") == 0) Name.resize(Name.size() - 2);
        // Use the pre-Hunt-Pass journal on clients. Worlds keep the component
        // active so the selected weekly rows still replicate and track progress.
        Decision = { NameIndex, NameNumber,
            !Globals::AmServer && Name == "HuntPassWeeklyChallengesFeature",
            g_ForcedFeatureFlags.count(Name) > 0 };
        AcquireSRWLockExclusive(&g_FeatureFlagLogLock);
        const bool First = g_LoggedFeatureFlags.insert(Name).second;
        ReleaseSRWLockExclusive(&g_FeatureFlagLogLock);
        if (First) MpLog("[FeatureFlags] " + Name + " baked=" + (Baked ? "1" : "0")
            + (Decision.ForcedOff ? " -> forced off" : (!Baked && Decision.InForcedSet ? " -> forced on" : "")));
        AcquireSRWLockExclusive(&g_FeatureFlagDecisionLock);
        g_FeatureFlagDecisions[Class] = Decision;
        ReleaseSRWLockExclusive(&g_FeatureFlagDecisionLock);
    }
    const bool Forced = !Baked && Decision.InForcedSet;
    return Decision.ForcedOff ? false : (Baked || Forced);
}

void InstallFeatureFlagHook(const char* Side) {
    MH_STATUS Create = RUNTIME_CREATE_HOOK((void*)(Globals::BaseAddress + kFeatureFlagIsEnabledRva),
        FeatureFlagIsEnabledHook, reinterpret_cast<LPVOID*>(&OrigFeatureFlagIsEnabled));
    MH_STATUS Enable = RuntimeHooks::Enable((void*)(Globals::BaseAddress + kFeatureFlagIsEnabledRva));
    MpLog(std::string("[") + Side + "] FeatureFlagIsEnabled create=" + MH_StatusToString(Create)
        + " enable=" + MH_StatusToString(Enable) + " target=+" + MpHex(kFeatureFlagIsEnabledRva));
}

// The seasonal event schedule on world servers.
//
// UTuningDataStatics::IsScheduledItemActive (Native112::IsScheduledItemActive) answers from
// UTuningDataProvider::SeasonalEventSchedule, and only the client fills that:
// it fetches /game_tuning/seasonal_event_schedule after logging in, and world
// servers never do (read from memory on 2026-09-25: one row on the client,
// none on the Ramsgate and Training Grounds servers). The world server decides
// which quests a player is offered, dropping a quest whose EventId is not
// active (QueryQuests via 0x01C13590, and UQuest::EvaluateUnlockConditions at
// 0x01BFC9D0), and it runs the hunts' event loot, so all of that stayed off.
// On world servers, an item the native schedule doesn't list is answered from
// the metagame's schedule instead, fetched once on the first check. The
// caller's time is still compared, so an event ends on its own.
//
// Native: bool(UObject* WorldContext, FName ID, FDateTime Now), with the FName
// and the FDateTime's ticks passed by value in rdx and r8.
static constexpr uintptr_t kIsScheduledItemActiveRva = Native112::IsScheduledItemActive;

static IsScheduledItemActiveFn OrigIsScheduledItemActive = nullptr;

static INIT_ONCE g_MetagameScheduleOnce = INIT_ONCE_STATIC_INIT;

static std::vector<FMetagameScheduleRow> g_MetagameSchedule;

static SRWLOCK g_ScheduleNameLock = SRWLOCK_INIT;

static std::map<uint64_t, std::string> g_ScheduleNames;

// FName bits -> name
static std::set<std::string> g_LoggedScheduleAnswers;

// "2026-09-25T00:00:00.000Z" -> FDateTime ticks (100 ns since 0001-01-01), or -1.
static int64_t IsoUtcToTicks(const std::string& Iso) {
    int Y = 0, Mo = 0, D = 0, H = 0, Mi = 0, S = 0;
    if (sscanf_s(Iso.c_str(), "%d-%d-%dT%d:%d:%d", &Y, &Mo, &D, &H, &Mi, &S) != 6) return -1;
    if (Mo < 1 || Mo > 12 || D < 1 || D > 31) return -1;
    const size_t Dot = Iso.find('.');
    const int Ms = Dot == std::string::npos ? 0 : atoi(Iso.substr(Dot + 1, 3).c_str());
    // Days since 1970-01-01 (H. Hinnant's days_from_civil).
    const int Yr = Y - (Mo <= 2 ? 1 : 0);
    const int Era = (Yr >= 0 ? Yr : Yr - 399) / 400;
    const int Yoe = Yr - Era * 400;
    const int Doy = (153 * (Mo + (Mo > 2 ? -3 : 9)) + 2) / 5 + D - 1;
    const int Doe = Yoe * 365 + Yoe / 4 - Yoe / 100 + Doy;
    const int64_t Days = static_cast<int64_t>(Era) * 146097 + Doe - 719468;
    const int64_t Seconds = Days * 86400 + H * 3600 + Mi * 60 + S;
    return 621355968000000000LL + Seconds * 10000000LL + static_cast<int64_t>(Ms) * 10000LL;
}

static std::string JsonStringField(const std::string& Json, const char* Key) {
    const std::string Pattern = std::string("\"") + Key + "\":\"";
    const size_t At = Json.find(Pattern);
    if (At == std::string::npos) return {};
    const size_t Start = At + Pattern.size();
    const size_t End = Json.find('"', Start);
    return End == std::string::npos ? std::string() : Json.substr(Start, End - Start);
}

// {"payload":{"ScheduledItems":[{"Name":"EVENT_DARKHARVEST","StartTime":"...",
//   "EndTime":"...", ..., "ScheduledItems":[{"ID":"EVENT_DARKHARVEST"}], ...}]}}
static void LoadMetagameSchedule() {
    if (Globals::MetagameAddress.empty()) {
        MpLog("[Schedule] no metagame address; native schedule only");
        return;
    }
    const std::string Body = HttpGetFromMetagame(L"/game_tuning/seasonal_event_schedule");
    std::string Loaded;
    for (size_t Row = Body.find("\"Name\":\""); Row != std::string::npos; ) {
        const size_t Next = Body.find("\"Name\":\"", Row + 1);
        const std::string Part = Body.substr(Row, Next == std::string::npos ? std::string::npos : Next - Row);
        const std::string Name = JsonStringField(Part, "Name");
        const int64_t Start = IsoUtcToTicks(JsonStringField(Part, "StartTime"));
        const int64_t End = IsoUtcToTicks(JsonStringField(Part, "EndTime"));
        if (!Name.empty() && Start >= 0 && End > Start) {
            g_MetagameSchedule.push_back({ Name, Start, End });
            Loaded += (Loaded.empty() ? "" : ", ") + Name + " " + JsonStringField(Part, "StartTime")
                + ".." + JsonStringField(Part, "EndTime");
        }
        Row = Next;
    }
    MpLog("[Schedule] metagame schedule (" + std::to_string(Body.size()) + " bytes): "
        + (Loaded.empty() ? std::string("no rows") : Loaded));
}

static BOOL CALLBACK LoadMetagameScheduleOnce(PINIT_ONCE, PVOID, PVOID*) {
    LoadMetagameSchedule();
    return TRUE;
}

static bool __fastcall IsScheduledItemActiveHook(void* WorldContext, uint64_t Id, int64_t NowTicks) {
    if (OrigIsScheduledItemActive(WorldContext, Id, NowTicks)) return true;
    InitOnceExecuteOnce(&g_MetagameScheduleOnce, LoadMetagameScheduleOnce, nullptr, nullptr);
    if (g_MetagameSchedule.empty()) return false;

    std::string Name;
    AcquireSRWLockShared(&g_ScheduleNameLock);
    const auto Found = g_ScheduleNames.find(Id);
    const bool Known = Found != g_ScheduleNames.end();
    if (Known) Name = Found->second;
    ReleaseSRWLockShared(&g_ScheduleNameLock);
    if (!Known) {
        Name = reinterpret_cast<SDK::FName*>(&Id)->ToString();
        AcquireSRWLockExclusive(&g_ScheduleNameLock);
        g_ScheduleNames.emplace(Id, Name);
        ReleaseSRWLockExclusive(&g_ScheduleNameLock);
    }

    // FNames compare without case, so a name can print in another casing.
    bool Listed = false, Active = false;
    for (const FMetagameScheduleRow& Row : g_MetagameSchedule) {
        if (_stricmp(Row.Name.c_str(), Name.c_str()) != 0) continue;
        Listed = true;
        if (Row.StartTicks <= NowTicks && NowTicks < Row.EndTicks) { Active = true; break; }
    }
    if (Listed) {
        const std::string Answer = Name + (Active ? " active" : " not active");
        AcquireSRWLockExclusive(&g_ScheduleNameLock);
        const bool First = g_LoggedScheduleAnswers.insert(Answer).second;
        ReleaseSRWLockExclusive(&g_ScheduleNameLock);
        if (First) MpLog("[Schedule] " + Answer + " (from the metagame schedule)");
    }
    return Active;
}

void InstallScheduleHook(const char* Side) {
    MH_STATUS Create = RUNTIME_CREATE_HOOK((void*)(Globals::BaseAddress + kIsScheduledItemActiveRva),
        IsScheduledItemActiveHook, reinterpret_cast<LPVOID*>(&OrigIsScheduledItemActive));
    MH_STATUS Enable = RuntimeHooks::Enable((void*)(Globals::BaseAddress + kIsScheduledItemActiveRva));
    MpLog(std::string("[") + Side + "] IsScheduledItemActive create=" + MH_StatusToString(Create)
        + " enable=" + MH_StatusToString(Enable) + " target=+" + MpHex(kIsScheduledItemActiveRva));
}

void* OrigSchedulerInitialize = nullptr;

static constexpr int kTrialsRotationRowCount = 181;

static constexpr int kDefaultTrialsRotationMinutes = 7 * 24 * 60;

static int TrialsRotationMinutes() {
    static int Cached = 0;
    if (Cached != 0) return Cached;

    Cached = kDefaultTrialsRotationMinutes;
    char Value[32] = {};
    DWORD n = GetEnvironmentVariableA("TRIALS_ROTATION_MINUTES", Value, static_cast<DWORD>(sizeof(Value)));
    if (n > 0 && n < sizeof(Value)) {
        char* End = nullptr;
        long Parsed = std::strtol(Value, &End, 10);
        if (End != Value && *End == '\0' && Parsed >= 1 && Parsed <= 525600) {
            Cached = static_cast<int>(Parsed);
        }
    }
    return Cached;
}

static int TrialsLaunchWeekOverride() {
    char Value[16] = {};
    DWORD n = GetEnvironmentVariableA("MYSTICPARADOX_TRIALS_WEEK", Value, static_cast<DWORD>(sizeof(Value)));
    if (n == 0 || n >= sizeof(Value)) return 0;
    char* End = nullptr;
    long Parsed = std::strtol(Value, &End, 10);
    return (End != Value && *End == '\0' && Parsed >= 1 && Parsed <= kTrialsRotationRowCount)
        ? static_cast<int>(Parsed) : 0;
}

static bool TryParseTrialsScheduleWeek(const std::string& RowName, int& WeekOut) {
    static const std::string Prefix = "Scheduled_Arena_Hunt_";
    if (RowName.size() != Prefix.size() + 3 || RowName.compare(0, Prefix.size(), Prefix) != 0) return false;
    const char* Digits = RowName.c_str() + Prefix.size();
    if (Digits[0] < '0' || Digits[0] > '9' || Digits[1] < '0' || Digits[1] > '9' || Digits[2] < '0' || Digits[2] > '9') return false;
    int Week = (Digits[0] - '0') * 100 + (Digits[1] - '0') * 10 + (Digits[2] - '0');
    if (Week < 1 || Week > kTrialsRotationRowCount) return false;
    WeekOut = Week;
    return true;
}

static std::string TrialsScheduleRowName(int Week) {
    std::ostringstream Name;
    Name << "Scheduled_Arena_Hunt_" << std::setfill('0') << std::setw(3) << Week;
    return Name.str();
}

static void PatchArenaScheduleForCurrentTime(void* tablesArr) {

    if (!tablesArr || !IsReadablePointer(tablesArr, 0x10)) return;
    void** data = *reinterpret_cast<void***>(tablesArr);
    int num = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(tablesArr) + 8);
    if (!data || num <= 0 || num > 64 || !IsReadablePointer(data, 8)) return;

    FILETIME ft; GetSystemTimeAsFileTime(&ft);
    int64_t realNow = static_cast<int64_t>((static_cast<uint64_t>(ft.dwHighDateTime) << 32) | ft.dwLowDateTime) + 504911232000000000LL;
    constexpr int64_t kTicksPerHour = 36000000000LL;
    constexpr int64_t kTicksPerMinute = 600000000LL;
    constexpr int64_t kTicksPerDay = 864000000000LL;
    constexpr int64_t kNativeArenaWeek = kTicksPerDay * 7;
    constexpr int64_t kUnixEpochDotNetTicks = 621355968000000000LL;
    const int RotationMinutes = TrialsRotationMinutes();
    const int64_t RotationTicks = static_cast<int64_t>(RotationMinutes) * kTicksPerMinute;
    const int64_t Bucket = (realNow - kUnixEpochDotNetTicks) / RotationTicks;
    const int CurrentWeek = static_cast<int>(Bucket % kTrialsRotationRowCount) + 1;
    const int64_t BucketStart = kUnixEpochDotNetTicks + Bucket * RotationTicks;
    const int LaunchWeek = TrialsLaunchWeekOverride();

    for (int t = 0; t < num; ++t) {
        UObject* tobj = reinterpret_cast<UObject*>(data[t]);
        if (!tobj || !IsReadablePointer(tobj, 0x40)) continue;
        std::string tname = tobj->GetName();
        if (tname.find("arena") == std::string::npos && tname.find("Arena") == std::string::npos) continue;
        SDK::UDataTable* dt = static_cast<SDK::UDataTable*>(tobj);
        uint8_t* Rows[kTrialsRotationRowCount + 1] = {};
        int FoundRows = 0;
        for (auto& pair : dt->RowMap) {
            std::string rn = pair.Key().GetRawString();
            uint8_t* row = pair.Value();
            if (!row || !IsReadablePointer(row, 0x30)) continue;
            int Week = 0;
            if (!TryParseTrialsScheduleWeek(rn, Week)) continue;
            Rows[Week] = row;
            ++FoundRows;
        }

        if (LaunchWeek > 0) {
            uint8_t* target = Rows[LaunchWeek];
            if (target) {

                const int64_t NewStart = realNow - kTicksPerHour;
                *reinterpret_cast<int64_t*>(target + 0x20) = NewStart;
                *reinterpret_cast<int64_t*>(target + 0x28) = NewStart + kNativeArenaWeek;
            }
            MpLog(target
                ? "[TrialsSchedule] Initialize: launch-pinned row='" + TrialsScheduleRowName(LaunchWeek)
                    + "' duration=7d table=" + tname
                : "[TrialsSchedule] Initialize: launch-pinned row missing '" + TrialsScheduleRowName(LaunchWeek)
                    + "' table=" + tname);
            continue;
        }

        int PatchedRows = 0;
        for (int Week = 1; Week <= kTrialsRotationRowCount; ++Week) {
            uint8_t* target = Rows[Week];
            if (!target) continue;
            const int Forward = (Week - CurrentWeek + kTrialsRotationRowCount) % kTrialsRotationRowCount;
            const int64_t NewStart = BucketStart + static_cast<int64_t>(Forward) * RotationTicks;
            *reinterpret_cast<int64_t*>(target + 0x20) = NewStart;
            *reinterpret_cast<int64_t*>(target + 0x28) = NewStart + RotationTicks;
            ++PatchedRows;
        }
        MpLog("[TrialsSchedule] Initialize: rotating intervalMinutes=" + std::to_string(RotationMinutes)
            + " currentRow='" + TrialsScheduleRowName(CurrentWeek) + "' patchedRows=" + std::to_string(PatchedRows)
            + "/" + std::to_string(FoundRows) + " bucketStartTicks=" + std::to_string(BucketStart)
            + " horizonEndTicks=" + std::to_string(BucketStart + static_cast<int64_t>(kTrialsRotationRowCount) * RotationTicks)
            + " table=" + tname);
    }
}

void SchedulerInitializeHook(void* self, void* tablesArr) {
    __try { PatchArenaScheduleForCurrentTime(tablesArr); }
    __except (EXCEPTION_EXECUTE_HANDLER) {}
    reinterpret_cast<void(*)(void*, void*)>(OrigSchedulerInitialize)(self, tablesArr);
}
