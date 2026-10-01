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

#include "diagnostics/ExitTrace.h"
#include "core/RuntimeState.h"
#include "native/Addresses112.h"
#include "core/Logging.h"
#include "core/Memory.h"
#include "core/RuntimeHooks.h"

// Logs how the process ends (exit, abort, TerminateProcess, unhandled
// exceptions) with the caller and a stack, and guards one known bad FName
// read. Installed on world servers by InitServerHooks.

static std::string MpModuleOfAddress(void* Addr);
static std::string MpExitDiag(void* ReturnAddress);
static bool ShouldTraceExceptionCode(DWORD Code);

static void MpLogStack(const std::string& Tag, uint32_t Code) {
    void* Frames[32]{};
    USHORT Count = CaptureStackBackTrace(1, static_cast<DWORD>(std::size(Frames)), Frames, nullptr);

    std::string Msg = "[ExitTrace] " + Tag + " code=" + std::to_string(Code) + " stack=";

    for (USHORT i = 0; i < Count; ++i) {
        if (i != 0) {
            Msg += " ";
        }

        Msg += MpAddress(Frames[i]);
    }

    MpLog(Msg);
}

ExitProcessFn OrigExitProcess = nullptr;

RtlExitUserProcessFn OrigRtlExitUserProcess = nullptr;

TerminateProcessFn OrigTerminateProcess = nullptr;

RaiseExceptionFn OrigRaiseException = nullptr;

CExitFn OrigUcrtExit = nullptr;

CExitFn OrigUcrtUnderscoreExit = nullptr;

CExitFn OrigMsvcrtExit = nullptr;

CExitFn OrigMsvcrtUnderscoreExit = nullptr;

AbortFn OrigUcrtAbort = nullptr;

AbortFn OrigMsvcrtAbort = nullptr;

void* OrigUnhandledExceptionFilter = nullptr;

PVOID VectoredExceptionHandle = nullptr;

static volatile LONG ExceptionTraceCount = 0;

static std::string MpModuleOfAddress(void* Addr) {
    if (!Addr) {
        return "null";
    }

    HMODULE Module = nullptr;
    if (!GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            reinterpret_cast<LPCWSTR>(Addr),
            &Module) || !Module) {
        return "?";
    }

    wchar_t PathW[MAX_PATH]{};
    DWORD PathLen = GetModuleFileNameW(Module, PathW, static_cast<DWORD>(std::size(PathW)));
    if (PathLen == 0) {
        return "?";
    }

    std::wstring Path(PathW, PathLen);
    size_t Slash = Path.find_last_of(L"\\/");
    std::wstring Base = (Slash == std::wstring::npos) ? Path : Path.substr(Slash + 1);
    return MpNarrow(Base);
}

static std::string MpExitDiag(void* ReturnAddress) {
    DWORD Tid = GetCurrentThreadId();
    DWORD GameTid = static_cast<DWORD>(InterlockedCompareExchange(
        reinterpret_cast<volatile LONG*>(&GameTickThreadId), 0, 0));

    std::string Msg = " tid=" + std::to_string(Tid);
    Msg += " gameTid=" + std::to_string(GameTid);
    Msg += " isGameThread=";
    Msg += (GameTid != 0 && Tid == GameTid) ? "1" : "0";
    Msg += " retAddr=" + MpAddress(ReturnAddress);
    Msg += " retModule=" + MpModuleOfAddress(ReturnAddress);

    return Msg;
}

void WINAPI ExitProcessHook(UINT ExitCode) {
    void* Caller = _ReturnAddress();
    MpLog("[ExitTrace] kernel32!ExitProcess entry code=" + std::to_string(ExitCode) + MpExitDiag(Caller));
    MpLogStack("kernel32!ExitProcess", ExitCode);
    OrigExitProcess(ExitCode);
}

void WINAPI RtlExitUserProcessHook(ULONG ExitCode) {
    void* Caller = _ReturnAddress();
    MpLog("[ExitTrace] ntdll!RtlExitUserProcess entry code=" + std::to_string(ExitCode) + MpExitDiag(Caller));
    MpLogStack("ntdll!RtlExitUserProcess", ExitCode);
    OrigRtlExitUserProcess(ExitCode);
}

BOOL WINAPI TerminateProcessHook(HANDLE Process, UINT ExitCode) {
    void* Caller = _ReturnAddress();
    MpLog("[ExitTrace] kernelbase!TerminateProcess handle=" + MpPtr(Process)
        + " code=" + std::to_string(ExitCode)
        + MpExitDiag(Caller));
    MpLogStack("kernelbase!TerminateProcess", ExitCode);
    return OrigTerminateProcess(Process, ExitCode);
}

static bool ShouldTraceExceptionCode(DWORD Code) {
    if (Code == DBG_PRINTEXCEPTION_C ||
        Code == DBG_PRINTEXCEPTION_WIDE_C ||
        Code == 0x406D1388 ||
        Code == 0x40010005 ||
        Code == 0x40010006 ||
        Code == 0x40010007 ||
        Code == 0x40010008) {
        return false;
    }

    return true;
}

void LogExceptionRecord(const char* Tag, const EXCEPTION_RECORD* Record, const CONTEXT* Context) {
    if (!ShouldTraceExceptionCode(Record ? Record->ExceptionCode : 0)) {
        return;
    }

    LONG Count = InterlockedIncrement(&ExceptionTraceCount);
    if (Count > 96) {
        return;
    }

    std::string Msg = "[ExceptionTrace] ";
    Msg += Tag;

    if (Record) {
        Msg += " code=" + MpHex(Record->ExceptionCode);
        Msg += " flags=" + MpHex(Record->ExceptionFlags);
        Msg += " address=" + MpAddress(Record->ExceptionAddress);

        uintptr_t Base = Globals::BaseAddress ? Globals::BaseAddress : reinterpret_cast<uintptr_t>(GetModuleHandleA(nullptr));
        uintptr_t ExceptionAddress = reinterpret_cast<uintptr_t>(Record->ExceptionAddress);
        if (Base && ExceptionAddress >= Base && ExceptionAddress < Base + 0x08000000) {
            Msg += " rva=+" + MpHex(ExceptionAddress - Base);
        }

        if (Record->NumberParameters > 0) {
            Msg += " params=";
            DWORD ParamCount = Record->NumberParameters;
            if (ParamCount > EXCEPTION_MAXIMUM_PARAMETERS) {
                ParamCount = EXCEPTION_MAXIMUM_PARAMETERS;
            }

            for (DWORD i = 0; i < ParamCount; ++i) {
                if (i != 0) {
                    Msg += ",";
                }
                Msg += MpHex(static_cast<uintptr_t>(Record->ExceptionInformation[i]));
            }
        }
    }

#if defined(_M_X64)
    if (Context) {
        Msg += " rip=" + MpAddress(reinterpret_cast<void*>(Context->Rip));
        Msg += " rsp=" + MpHex(static_cast<uintptr_t>(Context->Rsp));
    }
#endif

    MpLog(Msg);
    MpLogStack(Tag, Record ? Record->ExceptionCode : 0);
}

void WINAPI RaiseExceptionHook(DWORD Code, DWORD Flags, DWORD ArgCount, const ULONG_PTR* Args) {
    EXCEPTION_RECORD Record{};
    Record.ExceptionCode = Code;
    Record.ExceptionFlags = Flags;
    Record.ExceptionAddress = _ReturnAddress();
    Record.NumberParameters = ArgCount > EXCEPTION_MAXIMUM_PARAMETERS ? EXCEPTION_MAXIMUM_PARAMETERS : ArgCount;

    if (Args && Record.NumberParameters > 0) {
        for (DWORD i = 0; i < Record.NumberParameters; ++i) {
            Record.ExceptionInformation[i] = Args[i];
        }
    }

    LogExceptionRecord("kernelbase!RaiseException", &Record, nullptr);
    OrigRaiseException(Code, Flags, ArgCount, Args);
}

LONG WINAPI VectoredExceptionTrace(EXCEPTION_POINTERS* ExceptionInfo) {
    static thread_local bool InHandler = false;
    if (InHandler) {
        return EXCEPTION_CONTINUE_SEARCH;
    }

    InHandler = true;
    if (IsReadablePointer(ExceptionInfo, sizeof(EXCEPTION_POINTERS))) {
        EXCEPTION_RECORD* Record = ExceptionInfo->ExceptionRecord;
        CONTEXT* Context = ExceptionInfo->ContextRecord;
        if (IsReadablePointer(Record, sizeof(EXCEPTION_RECORD))) {
#if defined(_M_X64)
            if (Context && IsReadablePointer(Context, sizeof(CONTEXT)) &&
                Record->ExceptionCode == EXCEPTION_ACCESS_VIOLATION &&
                Globals::BaseAddress &&
                Context->Rip == Native112::At(Globals::BaseAddress, Native112::FNameEntryTextRead)) {
                MpLog("[ExceptionTrace] guarding invalid FName text read at +0x24AE5B0 rdi="
                    + MpHex(static_cast<uintptr_t>(Context->Rdi))
                    + " access=" + (Record->NumberParameters > 1
                        ? MpHex(static_cast<uintptr_t>(Record->ExceptionInformation[1]))
                        : std::string("(unknown)")));

                Context->Rdi = Native112::At(Globals::BaseAddress, Native112::EmptyNameText);
                InHandler = false;
                return EXCEPTION_CONTINUE_EXECUTION;
            }
#endif
            LogExceptionRecord("VEH", Record, IsReadablePointer(Context, sizeof(CONTEXT)) ? Context : nullptr);
        }
    }
    InHandler = false;

    return EXCEPTION_CONTINUE_SEARCH;
}

void __cdecl UcrtExitHook(int ExitCode) {
    void* Caller = _ReturnAddress();
    MpLog("[ExitTrace] ucrtbase!exit entry code=" + std::to_string(ExitCode) + MpExitDiag(Caller));
    MpLogStack("ucrtbase!exit", static_cast<uint32_t>(ExitCode));
    OrigUcrtExit(ExitCode);
}

void __cdecl UcrtUnderscoreExitHook(int ExitCode) {
    void* Caller = _ReturnAddress();
    MpLog("[ExitTrace] ucrtbase!_exit entry code=" + std::to_string(ExitCode) + MpExitDiag(Caller));
    MpLogStack("ucrtbase!_exit", static_cast<uint32_t>(ExitCode));
    OrigUcrtUnderscoreExit(ExitCode);
}

void __cdecl MsvcrtExitHook(int ExitCode) {
    void* Caller = _ReturnAddress();
    MpLog("[ExitTrace] msvcrt!exit entry code=" + std::to_string(ExitCode) + MpExitDiag(Caller));
    MpLogStack("msvcrt!exit", static_cast<uint32_t>(ExitCode));
    OrigMsvcrtExit(ExitCode);
}

void __cdecl MsvcrtUnderscoreExitHook(int ExitCode) {
    void* Caller = _ReturnAddress();
    MpLog("[ExitTrace] msvcrt!_exit entry code=" + std::to_string(ExitCode) + MpExitDiag(Caller));
    MpLogStack("msvcrt!_exit", static_cast<uint32_t>(ExitCode));
    OrigMsvcrtUnderscoreExit(ExitCode);
}

void __cdecl UcrtAbortHook() {
    void* Caller = _ReturnAddress();
    MpLog("[ExitTrace] ucrtbase!abort entry" + MpExitDiag(Caller));
    MpLogStack("ucrtbase!abort", 3);
    OrigUcrtAbort();
}

void __cdecl MsvcrtAbortHook() {
    void* Caller = _ReturnAddress();
    MpLog("[ExitTrace] msvcrt!abort entry" + MpExitDiag(Caller));
    MpLogStack("msvcrt!abort", 3);
    OrigMsvcrtAbort();
}

LONG WINAPI UEUnhandledExceptionFilterHook(EXCEPTION_POINTERS* ExceptionInfo) {
    std::string Msg = "[ExitTrace] UEUnhandledExceptionFilter";

    if (IsReadablePointer(ExceptionInfo, sizeof(EXCEPTION_POINTERS)) &&
        IsReadablePointer(ExceptionInfo->ExceptionRecord, sizeof(EXCEPTION_RECORD))) {
        EXCEPTION_RECORD* Record = ExceptionInfo->ExceptionRecord;
        Msg += " code=" + MpHex(Record->ExceptionCode);
        Msg += " flags=" + MpHex(Record->ExceptionFlags);
        Msg += " address=" + MpAddress(Record->ExceptionAddress);

        uintptr_t Base = Globals::BaseAddress ? Globals::BaseAddress : reinterpret_cast<uintptr_t>(GetModuleHandleA(nullptr));
        uintptr_t ExceptionAddress = reinterpret_cast<uintptr_t>(Record->ExceptionAddress);
        if (Base && ExceptionAddress >= Base && ExceptionAddress < Base + 0x08000000) {
            Msg += " rva=+" + MpHex(ExceptionAddress - Base);
        }
    }
    else {
        Msg += " exception_info_unreadable=" + MpPtr(ExceptionInfo);
    }

#if defined(_M_X64)
    if (IsReadablePointer(ExceptionInfo, sizeof(EXCEPTION_POINTERS)) &&
        IsReadablePointer(ExceptionInfo->ContextRecord, sizeof(CONTEXT))) {
        Msg += " rip=" + MpAddress(reinterpret_cast<void*>(ExceptionInfo->ContextRecord->Rip));
        Msg += " rsp=" + MpHex(static_cast<uintptr_t>(ExceptionInfo->ContextRecord->Rsp));
    }
#endif

    MpLog(Msg);
    MpLogStack("UEUnhandledExceptionFilter", 3);

    return reinterpret_cast<LONG(WINAPI*)(EXCEPTION_POINTERS*)>(OrigUnhandledExceptionFilter)(ExceptionInfo);
}

void InstallExitTraceHooks() {
    InstallApiHook(L"kernel32.dll", "ExitProcess", ExitProcessHook, reinterpret_cast<LPVOID*>(&OrigExitProcess), "kernel32!ExitProcess");
    InstallApiHook(L"ntdll.dll", "RtlExitUserProcess", RtlExitUserProcessHook, reinterpret_cast<LPVOID*>(&OrigRtlExitUserProcess), "ntdll!RtlExitUserProcess");
    InstallApiHook(L"kernelbase.dll", "TerminateProcess", TerminateProcessHook, reinterpret_cast<LPVOID*>(&OrigTerminateProcess), "kernelbase!TerminateProcess");
    InstallApiHook(L"kernelbase.dll", "RaiseException", RaiseExceptionHook, reinterpret_cast<LPVOID*>(&OrigRaiseException), "kernelbase!RaiseException");
    InstallApiHook(L"ucrtbase.dll", "exit", UcrtExitHook, reinterpret_cast<LPVOID*>(&OrigUcrtExit), "ucrtbase!exit");
    InstallApiHook(L"ucrtbase.dll", "_exit", UcrtUnderscoreExitHook, reinterpret_cast<LPVOID*>(&OrigUcrtUnderscoreExit), "ucrtbase!_exit");
    InstallApiHook(L"ucrtbase.dll", "abort", UcrtAbortHook, reinterpret_cast<LPVOID*>(&OrigUcrtAbort), "ucrtbase!abort");
    InstallApiHook(L"msvcrt.dll", "exit", MsvcrtExitHook, reinterpret_cast<LPVOID*>(&OrigMsvcrtExit), "msvcrt!exit");
    InstallApiHook(L"msvcrt.dll", "_exit", MsvcrtUnderscoreExitHook, reinterpret_cast<LPVOID*>(&OrigMsvcrtUnderscoreExit), "msvcrt!_exit");
    InstallApiHook(L"msvcrt.dll", "abort", MsvcrtAbortHook, reinterpret_cast<LPVOID*>(&OrigMsvcrtAbort), "msvcrt!abort");
    VectoredExceptionHandle = AddVectoredExceptionHandler(1, VectoredExceptionTrace);
    MpLog("[ExceptionTrace] AddVectoredExceptionHandler handle=" + MpPtr(VectoredExceptionHandle));
    RUNTIME_INSTALL_HOOK(Native112::UnhandledExceptionFilter, UEUnhandledExceptionFilterHook, &OrigUnhandledExceptionFilter);
}
