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

#pragma once
#include "core/Runtime.h"

using ExitProcessFn = void(WINAPI*)(UINT);

using RtlExitUserProcessFn = void(WINAPI*)(ULONG);

using TerminateProcessFn = BOOL(WINAPI*)(HANDLE, UINT);

using RaiseExceptionFn = void(WINAPI*)(DWORD, DWORD, DWORD, const ULONG_PTR*);

using CExitFn = void(__cdecl*)(int);

using AbortFn = void(__cdecl*)();

extern ExitProcessFn OrigExitProcess;

extern RtlExitUserProcessFn OrigRtlExitUserProcess;

extern TerminateProcessFn OrigTerminateProcess;

extern RaiseExceptionFn OrigRaiseException;

extern CExitFn OrigUcrtExit;

extern CExitFn OrigUcrtUnderscoreExit;

extern CExitFn OrigMsvcrtExit;

extern CExitFn OrigMsvcrtUnderscoreExit;

extern AbortFn OrigUcrtAbort;

extern AbortFn OrigMsvcrtAbort;

extern void* OrigUnhandledExceptionFilter;

extern PVOID VectoredExceptionHandle;

extern volatile DWORD GameTickThreadId;

void WINAPI ExitProcessHook(UINT ExitCode);

void WINAPI RtlExitUserProcessHook(ULONG ExitCode);

BOOL WINAPI TerminateProcessHook(HANDLE Process, UINT ExitCode);

void LogExceptionRecord(const char* Tag, const EXCEPTION_RECORD* Record, const CONTEXT* Context);

void WINAPI RaiseExceptionHook(DWORD Code, DWORD Flags, DWORD ArgCount, const ULONG_PTR* Args);

LONG WINAPI VectoredExceptionTrace(EXCEPTION_POINTERS* ExceptionInfo);

void __cdecl UcrtExitHook(int ExitCode);

void __cdecl UcrtUnderscoreExitHook(int ExitCode);

void __cdecl MsvcrtExitHook(int ExitCode);

void __cdecl MsvcrtUnderscoreExitHook(int ExitCode);

void __cdecl UcrtAbortHook();

void __cdecl MsvcrtAbortHook();

LONG WINAPI UEUnhandledExceptionFilterHook(EXCEPTION_POINTERS* ExceptionInfo);

void LogArchonLifecycle(const char* Tag);

extern std::atomic<int>   g_wdIsHub;

extern std::atomic<uint32_t> g_wdGameThreadId;

inline constexpr int  kPeRing = 32;

extern char           g_gtPeNameRing[kPeRing][160];

extern std::atomic<uint32_t> g_gtPeRingPos;

extern std::atomic<void*>    g_gtPeCurFunc;

extern std::atomic<void*>    g_gtPeCurObj;

void MpReapExit(const char* Reason);

void BleedoutNoteEvent(const std::string& FunctionName, void* Obj);

int GameModeEmptyState();

extern bool EnableWatchdog;

void StartEmptyWatchdogThread();

float SafeCallPlayerRoleFloat(void* PlayerRole, uintptr_t Rva);

int SafeCallPlayerRoleBoolRva(void* PlayerRole, uintptr_t Rva);

struct PlayerRoleModifierSnapshot {
    bool Valid = false;
    void* Group = nullptr;
    int DesiredBuffs = -1;
    int DesiredEffects = -1;
    int DesiredAbilities = -1;
    int AppliedBuffs = -1;
    int AppliedEffects = -1;
    int AppliedAbilities = -1;
    int PendingBuffs = -1;
    int PendingEffects = -1;
    int PendingAbilities = -1;
};

PlayerRoleModifierSnapshot CapturePlayerRoleModifiers(void* PlayerRole);

std::string PlayerRoleModifierSummary(void* PlayerRole);

std::string PlayerRoleChargeSummary(void* PlayerRole);

struct AbilitySpecDiagnostic {
    void* Ability = nullptr;
    void* SourceObject = nullptr;
    int Level = -1;
    int InputId = -1;
};

AbilitySpecDiagnostic FindAbilitySpecDiagnostic(UAbilitySystemComponent* Component, uint32_t Handle);

std::string SafeObjectNameForDiagnostic(void* Object);

std::string ExperienceGrantSummary(const FExperienceGrant& Grant);

bool IsClientExperienceGrantConsumer(const std::string& FunctionName);

int TraceEscalationFlowEnter(const char* Side, UObject* Object,
                                    const std::string& FunctionName, void* Parms);

void TraceEscalationFlowExit(const char* Side, int Seq, UObject* Object,
                                   const std::string& FunctionName, void* Parms);

bool CoreCaptureEnabled();
