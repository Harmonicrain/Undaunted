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

#pragma once
#include "core/Runtime.h"

// Process exit and exception tracing ([ExitTrace], [ExceptionTrace]).

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

// Hooks the process exit paths and the engine's unhandled exception filter, and
// adds the vectored exception handler. World servers only.
void InstallExitTraceHooks();
