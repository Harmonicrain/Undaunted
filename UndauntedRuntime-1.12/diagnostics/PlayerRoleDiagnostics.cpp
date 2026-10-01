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
 * diagnostics/RuntimeDiagnostics.cpp. Not an official release of
 * Mystic Paradox or Undaunted.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#include "diagnostics/PlayerRoleDiagnostics.h"
#include "core/RuntimeState.h"
#include "native/Addresses112.h"
#include "core/Logging.h"
#include "core/Memory.h"

struct PlayerRoleChargeSnapshot {
    bool Valid = false;
    float MaxAbilityCharge = 0.0f;
    float Value = 0.0f;
    float Rate = 0.0f;
    float LastUpdateTime = 0.0f;
    float MaxValue = 0.0f;
    float MinValue = 0.0f;
    int NetDormancy = -1;
    float NetUpdateFrequency = 0.0f;
};

static PlayerRoleChargeSnapshot CapturePlayerRoleCharge(void* PlayerRole);

float SafeCallPlayerRoleFloat(void* PlayerRole, uintptr_t Rva) {
    __try {
        if (!PlayerRole || !Globals::BaseAddress || !Rva) return -9999.0f;
        return reinterpret_cast<float(*)(void*)>(Globals::BaseAddress + Rva)(PlayerRole);
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return -9999.0f;
    }
}

int SafeCallPlayerRoleBoolRva(void* PlayerRole, uintptr_t Rva) {
    __try {
        if (!PlayerRole || !Globals::BaseAddress || !Rva) return -1;
        return reinterpret_cast<bool(*)(void*)>(Globals::BaseAddress + Rva)(PlayerRole) ? 1 : 0;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return -2;
    }
}

PlayerRoleModifierSnapshot CapturePlayerRoleModifiers(void* PlayerRole) {
    PlayerRoleModifierSnapshot Result{};
    __try {
        if (!PlayerRole || !IsReadablePointer(PlayerRole, 0x300)) return Result;
        const uintptr_t Role = reinterpret_cast<uintptr_t>(PlayerRole);
        Result.DesiredBuffs = *reinterpret_cast<const int*>(Role + 0x2B0);
        Result.DesiredEffects = *reinterpret_cast<const int*>(Role + 0x2C0);
        Result.DesiredAbilities = *reinterpret_cast<const int*>(Role + 0x2D0);
        Result.Group = *reinterpret_cast<void* const*>(Role + 0x2F8);
        if (Result.DesiredBuffs < 0 || Result.DesiredBuffs > 256
            || Result.DesiredEffects < 0 || Result.DesiredEffects > 256
            || Result.DesiredAbilities < 0 || Result.DesiredAbilities > 256) return Result;

        if (Result.Group) {
            if (!IsReadablePointer(Result.Group, 0xD0)) return Result;
            const uintptr_t Group = reinterpret_cast<uintptr_t>(Result.Group);
            Result.AppliedEffects = *reinterpret_cast<const int*>(Group + 0x68);
            Result.AppliedAbilities = *reinterpret_cast<const int*>(Group + 0x78);
            Result.AppliedBuffs = *reinterpret_cast<const int*>(Group + 0x88);
            Result.PendingBuffs = *reinterpret_cast<const int*>(Group + 0xA8);
            Result.PendingEffects = *reinterpret_cast<const int*>(Group + 0xB8);
            Result.PendingAbilities = *reinterpret_cast<const int*>(Group + 0xC8);
            const int Counts[] = { Result.AppliedEffects, Result.AppliedAbilities, Result.AppliedBuffs,
                Result.PendingBuffs, Result.PendingEffects, Result.PendingAbilities };
            for (int Count : Counts) {
                if (Count < 0 || Count > 256) return Result;
            }
        }
        Result.Valid = true;
        return Result;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return PlayerRoleModifierSnapshot{};
    }
}

std::string PlayerRoleModifierSummary(void* PlayerRole) {
    if (!PlayerRole) return "role=null";
    const PlayerRoleModifierSnapshot Snapshot = CapturePlayerRoleModifiers(PlayerRole);
    if (!Snapshot.Valid) return "role=" + MpPtr(PlayerRole) + " unreadable";
    return "group=" + MpPtr(Snapshot.Group)
        + " desired[b=" + std::to_string(Snapshot.DesiredBuffs)
        + ",e=" + std::to_string(Snapshot.DesiredEffects)
        + ",a=" + std::to_string(Snapshot.DesiredAbilities) + "]"
        + " applied[b=" + std::to_string(Snapshot.AppliedBuffs)
        + ",e=" + std::to_string(Snapshot.AppliedEffects)
        + ",a=" + std::to_string(Snapshot.AppliedAbilities) + "]"
        + " pending[b=" + std::to_string(Snapshot.PendingBuffs)
        + ",e=" + std::to_string(Snapshot.PendingEffects)
        + ",a=" + std::to_string(Snapshot.PendingAbilities) + "]";
}

static PlayerRoleChargeSnapshot CapturePlayerRoleCharge(void* PlayerRole) {
    PlayerRoleChargeSnapshot Result{};
    if (!PlayerRole || !IsReadablePointer(PlayerRole, 0x35C)) return Result;
    const uintptr_t Base = reinterpret_cast<uintptr_t>(PlayerRole);
    Result.Valid = true;
    Result.MaxAbilityCharge = *reinterpret_cast<const float*>(Base + 0x308);
    Result.Value = *reinterpret_cast<const float*>(Base + 0x348);
    Result.Rate = *reinterpret_cast<const float*>(Base + 0x34C);
    Result.LastUpdateTime = *reinterpret_cast<const float*>(Base + 0x350);
    Result.MaxValue = *reinterpret_cast<const float*>(Base + 0x354);
    Result.MinValue = *reinterpret_cast<const float*>(Base + 0x358);
    Result.NetDormancy = *reinterpret_cast<const uint8_t*>(Base + 0xF1);
    Result.NetUpdateFrequency = *reinterpret_cast<const float*>(Base + 0x108);
    return Result;
}

std::string PlayerRoleChargeSummary(void* PlayerRole) {
    if (!PlayerRole) return "role=null";
    const PlayerRoleChargeSnapshot Snapshot = CapturePlayerRoleCharge(PlayerRole);
    if (!Snapshot.Valid) return "role=" + MpPtr(PlayerRole) + " unreadable";
    const float Current = SafeCallPlayerRoleFloat(PlayerRole, Native112::PlayerRoleCurrentCharge);
    const float Percent = SafeCallPlayerRoleFloat(PlayerRole, Native112::PlayerRoleChargePercent);
    const float CurrentRate = SafeCallPlayerRoleFloat(PlayerRole, Native112::PlayerRoleCurrentChargeRate);
    const float NativeMax = SafeCallPlayerRoleFloat(PlayerRole, Native112::PlayerRoleMaxCharge);

    const int CanActivateNative = SafeCallPlayerRoleBoolRva(PlayerRole, Native112::PlayerRoleCanActivate);
    return "role=" + MpPtr(PlayerRole)
        + " max=" + std::to_string(Snapshot.MaxAbilityCharge)
        + " lazyValue=" + std::to_string(Snapshot.Value)
        + " lazyRate=" + std::to_string(Snapshot.Rate)
        + " lazyLast=" + std::to_string(Snapshot.LastUpdateTime)
        + " lazyMax=" + std::to_string(Snapshot.MaxValue)
        + " lazyMin=" + std::to_string(Snapshot.MinValue)
        + " current=" + std::to_string(Current)
        + " percent=" + std::to_string(Percent)
        + " currentRate=" + std::to_string(CurrentRate)
        + " nativeMax=" + std::to_string(NativeMax)
        + " canActivateNative=" + std::to_string(CanActivateNative)
        + " canNativeRva=" + MpHex(Native112::PlayerRoleCanActivate)
        + " dormancy=" + std::to_string(Snapshot.NetDormancy)
        + " netHz=" + std::to_string(Snapshot.NetUpdateFrequency);
}

AbilitySpecDiagnostic FindAbilitySpecDiagnostic(UAbilitySystemComponent* Component, uint32_t Handle) {
    AbilitySpecDiagnostic Result{};
    if (!Component || !IsReadablePointer(Component, 0x508)) return Result;
    const uintptr_t Items = reinterpret_cast<uintptr_t>(Component) + 0x4F8;
    void* Data = *reinterpret_cast<void**>(Items);
    const int Num = *reinterpret_cast<int*>(Items + 8);
    if (!Data || Num <= 0 || Num > 4096
        || !IsReadablePointer(Data, static_cast<size_t>(Num) * 0xE0)) return Result;
    for (int i = 0; i < Num; ++i) {
        const uintptr_t Spec = reinterpret_cast<uintptr_t>(Data) + static_cast<uintptr_t>(i) * 0xE0;
        if (*reinterpret_cast<const uint32_t*>(Spec + 0x0C) != Handle) continue;
        Result.Ability = *reinterpret_cast<void**>(Spec + 0x10);
        Result.Level = *reinterpret_cast<const int*>(Spec + 0x18);
        Result.InputId = *reinterpret_cast<const int*>(Spec + 0x1C);
        Result.SourceObject = *reinterpret_cast<void**>(Spec + 0x20);
        break;
    }
    return Result;
}

std::string ExperienceGrantSummary(const FExperienceGrant& Grant) {
    return "type=" + std::to_string(static_cast<int>(Grant.ExperienceType))
        + " increase=" + std::to_string(Grant.IncreaseAmount)
        + " boost=" + std::to_string(Grant.BoostAmount)
        + " level=" + std::to_string(Grant.PreviousLevel) + "->" + std::to_string(Grant.Level)
        + " levelAmount=" + std::to_string(Grant.PreviousLevelAmount) + "->" + std::to_string(Grant.LevelAmount)
        + " maxLevelAmount=" + std::to_string(Grant.PreviousMaxLevelAmount) + "->" + std::to_string(Grant.MaxLevelAmount);
}

bool IsClientExperienceGrantConsumer(const std::string& FunctionName) {
    return FunctionName.find("HUDExperienceBar.OnPlayerExperienceGranted") != std::string::npos
        || FunctionName.find("mastery_stinger_manager_C.OnExperienceGranted") != std::string::npos
        || FunctionName.find("Objective_PlayerXP.OnExperienceGranted") != std::string::npos
        || FunctionName.find("PlayerJourneyComponent.HandleGrantPlayerExperience") != std::string::npos;
}
