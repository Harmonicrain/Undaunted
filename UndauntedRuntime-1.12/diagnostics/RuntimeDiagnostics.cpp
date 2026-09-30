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

#include "diagnostics/RuntimeDiagnostics.h"
#include "core/RuntimeState.h"
#include "native/Addresses112.h"
#include "core/EngineTick.h"
#include "core/Logging.h"
#include "core/Memory.h"
#include "core/PlayerRoles.h"

struct BleedoutWatchEntry {
    void*    Comp;
    uint64_t EnteredMs;
    float    DurationAtEntry;
    bool     Warned;
};

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

static void MpLogStack(const std::string& Tag, uint32_t Code);
static std::string MpModuleOfAddress(void* Addr);
static std::string MpExitDiag(void* ReturnAddress);
static bool ShouldTraceExceptionCode(DWORD Code);
static int ScanStackReturns(uint64_t rsp, uint64_t codeLo, uint64_t codeHi, uint64_t* out, int maxOut);
static void MpLogRealStack(CONTEXT ctx);
static void MpLogAllThreadRips(uint32_t gameTid);
static void MpLogHungGameThread();
static float BleedoutDurationFallback();
static void EnsureBleedoutDuration(SDK::UObject* GameMode);
static std::string BleedoutSnapshot(void* Comp);
static void BleedoutWatchEnter(void* Comp, float Duration);
static void BleedoutWatchExit(void* Comp);
static void BleedoutWatchTick();
static PlayerRoleChargeSnapshot CapturePlayerRoleCharge(void* PlayerRole);
static bool IsEscalationFlowFunction(const std::string& FunctionName);
static UObject* ResolveEscalationFlowPlayer(UObject* Object, const std::string& FunctionName,
                                            void* Parms, const char* Side);
static std::string EscalationArrayState(UObject* Object);
static std::string EscalationFlowParams(const std::string& FunctionName, void* Parms);
static std::string EscalationFlowContext(UObject* Object, const std::string& FunctionName,
                                         void* Parms, const char* Side);

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

volatile DWORD GameTickThreadId = 0;

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
                Context->Rip == Native112::At(Globals::BaseAddress, Native112::Rva_024AE5B0)) {
                MpLog("[ExceptionTrace] guarding invalid FName text read at +0x24AE5B0 rdi="
                    + MpHex(static_cast<uintptr_t>(Context->Rdi))
                    + " access=" + (Record->NumberParameters > 1
                        ? MpHex(static_cast<uintptr_t>(Record->ExceptionInformation[1]))
                        : std::string("(unknown)")));

                Context->Rdi = Native112::At(Globals::BaseAddress, Native112::Rva_04DF2E8C);
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

void LogArchonLifecycle(const char* Tag) {
    if (!SDK::UObject::GObjects) { return; }
    SDK::UObject* GmObj = nullptr;
    SDK::UObject* GsObj = nullptr;
    const int Count = SDK::UObject::GObjects->Num();
    for (int i = 0; i < Count; i++) {
        SDK::UObject* Obj = SDK::UObject::GObjects->GetByIndex(i);
        if (!Obj || Obj->IsDefaultObject()) { continue; }
        if (!GmObj && Obj->IsA(SDK::AArchonGameMode::StaticClass())) { GmObj = Obj; }
        else if (!GsObj && Obj->IsA(SDK::AArchonGameState::StaticClass())) { GsObj = Obj; }
        if (GmObj && GsObj) { break; }
    }

    std::string Msg = std::string("[Lifecycle:") + Tag + "]";

    if (GmObj && IsReadablePointer(GmObj, 0x4A0)) {
        uintptr_t Gm = reinterpret_cast<uintptr_t>(GmObj);
        std::string MatchState = "?";
        if (IsReadablePointer(reinterpret_cast<void*>(Gm + 0x02C0), 8)) {
            MatchState = reinterpret_cast<SDK::FName*>(Gm + 0x02C0)->ToString();
        }
        void* GameSession = *reinterpret_cast<void**>(Gm + 0x0278);
        int32_t GsMax = -1;
        if (IsReadablePointer(GameSession, 0x228)) {
            GsMax = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(GameSession) + 0x0224);
        }
        Msg += " GM=" + MpPtr(GmObj) + " class=" + GmObj->Class->GetName()
            + " match=" + MatchState
            + " NumPlayers=" + std::to_string(*reinterpret_cast<int32_t*>(Gm + 0x02D0))
            + " NumSpectators=" + std::to_string(*reinterpret_cast<int32_t*>(Gm + 0x02CC))
            + " NumTravelling=" + std::to_string(*reinterpret_cast<int32_t*>(Gm + 0x02DC))
            + " ExpectedPlayerCount=" + std::to_string(*reinterpret_cast<int32_t*>(Gm + 0x0498))
            + " MaxPlayers=" + std::to_string(*reinterpret_cast<int32_t*>(Gm + 0x049C))
            + " GameSession=" + MpPtr(GameSession) + " GS.MaxPlayers=" + std::to_string(GsMax);
    } else {
        Msg += " GM=null";
    }

    if (GsObj && IsReadablePointer(GsObj, 0x278)) {
        uintptr_t Gs = reinterpret_cast<uintptr_t>(GsObj);
        std::string GsMatch = "?";
        if (IsReadablePointer(reinterpret_cast<void*>(Gs + 0x0270), 8)) {
            GsMatch = reinterpret_cast<SDK::FName*>(Gs + 0x0270)->ToString();
        }
        Msg += " | GState=" + MpPtr(GsObj) + " match=" + GsMatch;
    } else {
        Msg += " | GState=null";
    }

    MpLog(Msg);
}

static SDK::UObject* g_CachedGameMode = nullptr;

static uint64_t g_LastGameModeSearchMs = 0;

static std::atomic<void*> g_wdGameModePtr{ nullptr };

std::atomic<int>   g_wdIsHub{ -1 };

static std::atomic<uint64_t> g_wdLastTickMs{ 0 };

static std::atomic<bool> g_wdSawPlayer{ false };

std::atomic<uint32_t> g_wdGameThreadId{ 0 };

char           g_gtPeNameRing[kPeRing][160] = {};

std::atomic<uint32_t> g_gtPeRingPos{ 0 };

std::atomic<void*>    g_gtPeCurFunc{ nullptr };

std::atomic<void*>    g_gtPeCurObj{ nullptr };

void MpReapExit(const char* Reason) {
    MpLog(std::string("[Watchdog/thread] ") + Reason
        + " -> TerminateProcess(0) (skipping UE static teardown; see MpReapExit comment)");

    Sleep(50);
    TerminateProcess(GetCurrentProcess(), 0);

    exit(0);
}

static int ScanStackReturns(uint64_t rsp, uint64_t codeLo, uint64_t codeHi, uint64_t* out, int maxOut) {
    int n = 0;
    for (uint64_t p = rsp; p < rsp + 0x1400 && n < maxOut; p += 8) {
        if (!IsReadablePointer(reinterpret_cast<void*>(p), 8)) break;
        uint64_t v = *reinterpret_cast<uint64_t*>(p);
        if (v >= codeLo && v < codeHi) out[n++] = v;
    }
    return n;
}

static void MpLogRealStack(CONTEXT ctx) {
    for (int i = 0; i < 30 && ctx.Rip; ++i) {
        MpLog("[HangTrace]   frame[" + std::to_string(i) + "] " + MpAddress(reinterpret_cast<void*>(ctx.Rip)));
        DWORD64 imgBase = 0;
        PRUNTIME_FUNCTION rf = RtlLookupFunctionEntry(ctx.Rip, &imgBase, nullptr);
        if (rf) {
            PVOID handlerData = nullptr; DWORD64 establisher = 0;
            RtlVirtualUnwind(UNW_FLAG_NHANDLER, imgBase, ctx.Rip, rf, &ctx, &handlerData, &establisher, nullptr);
        } else {

            if (!IsReadablePointer(reinterpret_cast<void*>(ctx.Rsp), 8)) break;
            ctx.Rip = *reinterpret_cast<DWORD64*>(ctx.Rsp);
            ctx.Rsp += 8;
        }
    }
}

static void MpLogAllThreadRips(uint32_t gameTid) {
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if (snap == INVALID_HANDLE_VALUE) { MpLog("[HangTrace] thread snapshot failed"); return; }
    THREADENTRY32 te{}; te.dwSize = sizeof(te);
    const DWORD myPid = GetCurrentProcessId();
    const DWORD selfTid = GetCurrentThreadId();
    int logged = 0;
    if (Thread32First(snap, &te)) {
        do {
            if (te.th32OwnerProcessID != myPid || te.th32ThreadID == selfTid) continue;
            HANDLE th = OpenThread(THREAD_GET_CONTEXT | THREAD_SUSPEND_RESUME | THREAD_QUERY_INFORMATION, FALSE, te.th32ThreadID);
            if (!th) continue;
            CONTEXT c{}; c.ContextFlags = CONTEXT_CONTROL;
            uint64_t rip = 0;
            if (SuspendThread(th) != (DWORD)-1) { if (GetThreadContext(th, &c)) rip = c.Rip; ResumeThread(th); }
            CloseHandle(th);
            if (rip) {
                MpLog("[HangTrace] thread tid=" + std::to_string(te.th32ThreadID)
                    + (te.th32ThreadID == gameTid ? " (GAME)" : "")
                    + " RIP=" + MpAddress(reinterpret_cast<void*>(rip)));
                ++logged;
            }
        } while (Thread32Next(snap, &te) && logged < 96);
    }
    CloseHandle(snap);
    MpLog("[HangTrace] all-thread snapshot: " + std::to_string(logged) + " threads sampled");
}

static void MpLogHungGameThread() {
    uint32_t Tid = g_wdGameThreadId.load(std::memory_order_relaxed);
    if (Tid == 0) { MpLog("[HangTrace] game thread id unknown; cannot sample"); return; }

    HANDLE Th = OpenThread(THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION | THREAD_SUSPEND_RESUME, FALSE, Tid);
    if (!Th) { MpLog("[HangTrace] OpenThread failed for tid=" + std::to_string(Tid)); return; }

    uint64_t rip[3] = { 0,0,0 };
    uint64_t rsp0 = 0;
    uint64_t retChain[12] = {};
    int      retN = 0;
    CONTEXT  fullCtx0{};
    bool     haveCtx0 = false;
    const uint64_t codeLo = Native112::At(Globals::BaseAddress, Native112::Rva_00001000);
    const uint64_t codeHi = Native112::At(Globals::BaseAddress, Native112::Rva_04E00000);

    for (int s = 0; s < 3; ++s) {
        CONTEXT Ctx{};
        Ctx.ContextFlags = CONTEXT_FULL;
        if (SuspendThread(Th) != (DWORD)-1) {
            if (GetThreadContext(Th, &Ctx)) {
                rip[s] = Ctx.Rip;
                if (s == 0) {
                    rsp0 = Ctx.Rsp;
                    fullCtx0 = Ctx; haveCtx0 = true;
                    retN = ScanStackReturns(Ctx.Rsp, codeLo, codeHi, retChain, 12);
                }
            }
            ResumeThread(Th);
        }
        if (s < 2) Sleep(250);
    }
    CloseHandle(Th);

    if (rip[0] == 0) { MpLog("[HangTrace] GetThreadContext failed for tid=" + std::to_string(Tid)); return; }

    bool moving = (rip[0] != rip[1]) || (rip[1] != rip[2]);
    MpLog("[HangTrace] game thread tid=" + std::to_string(Tid)
        + (moving ? " SPINNING (RIP moves - loop)" : " BLOCKED (RIP fixed - wait/deadlock)")
        + " RIP=" + MpAddress(reinterpret_cast<void*>(rip[0]))
        + " / " + MpAddress(reinterpret_cast<void*>(rip[1]))
        + " / " + MpAddress(reinterpret_cast<void*>(rip[2]))
        + " RSP=" + MpAddress(reinterpret_cast<void*>(rsp0)));

    if (haveCtx0) { MpLog("[HangTrace] REAL unwind (game thread):"); MpLogRealStack(fullCtx0); }

    std::string chain;
    for (int i = 0; i < retN; ++i) { chain += (i ? " <- " : "") + MpAddress(reinterpret_cast<void*>(retChain[i])); }
    MpLog("[HangTrace] heuristic retchain(" + std::to_string(retN) + "): " + (chain.empty() ? "(none in module)" : chain));

    MpLog("[HangTrace] curFunc=" + MpPtr(g_gtPeCurFunc.load(std::memory_order_relaxed))
        + " curObj=" + MpPtr(g_gtPeCurObj.load(std::memory_order_relaxed)));
    uint32_t pos = g_gtPeRingPos.load(std::memory_order_relaxed);
    for (int i = 1; i <= 10; ++i) {
        uint32_t idx = (pos - static_cast<uint32_t>(i)) % kPeRing;

        char buf[160]; memcpy(buf, g_gtPeNameRing[idx], sizeof(buf)); buf[sizeof(buf) - 1] = '\0';
        if (buf[0]) MpLog("[HangTrace]   recentPE[-" + std::to_string(i) + "] = " + std::string(buf));
    }

    MpLogAllThreadRips(Tid);
}

static float BleedoutDurationFallback() {

    static float Cached = -1.0f;
    if (Cached < 0.0f) {
        Cached = 30.0f;
        char Buf[32]{};
        if (GetEnvironmentVariableA("MYSTICPARADOX_BLEEDOUT_SECONDS", Buf, sizeof(Buf)) > 0) {
            float Parsed = static_cast<float>(atof(Buf));
            if (Parsed > 0.0f && Parsed < 600.0f) Cached = Parsed;
        }
    }
    return Cached;
}

static void EnsureBleedoutDuration(SDK::UObject* GameMode) {
    static bool s_done = false;
    if (s_done || !GameMode) return;
    if (!IsReadablePointer(GameMode, 0x548)) return;

    if (!GameMode->IsA(SDK::AArchonGameMode_Island::StaticClass())) { s_done = true; return; }

    float* Duration = reinterpret_cast<float*>(reinterpret_cast<uintptr_t>(GameMode) + 0x540);
    const float Original = *Duration;

    if (Original > 0.0f) {
        MpLog("[Bleedout] GameMode BleedoutDuration=" + std::to_string(Original)
            + "s (valid; no patch needed)");
        s_done = true;
        return;
    }

    *Duration = BleedoutDurationFallback();
    MpLog("[Bleedout] GameMode BleedoutDuration was " + std::to_string(Original)
        + " (<=0) — SetTimer would fail and the player would be stuck downed forever. Patched to "
        + std::to_string(*Duration) + "s.");
    s_done = true;
}

static std::string BleedoutSnapshot(void* Comp) {
    if (!Comp || !IsReadablePointer(Comp, 0x178)) return "comp=unreadable";
    const uintptr_t C = reinterpret_cast<uintptr_t>(Comp);

    const uint8_t  State     = *reinterpret_cast<uint8_t*>(C + 0x0B0);
    const uint8_t  PrevState = *reinterpret_cast<uint8_t*>(C + 0x0B1);
    const float    Duration  = *reinterpret_cast<float*>(C + 0x0B4);
    const uint8_t  Finishing = *reinterpret_cast<uint8_t*>(C + 0x130);
    const int32_t  RepNum    = *reinterpret_cast<int32_t*>(C + 0x150);
    const int32_t  NoHealth  = *reinterpret_cast<int32_t*>(C + 0x160);
    const uint8_t  Ready     = *reinterpret_cast<uint8_t*>(C + 0x170);

    return "comp=" + MpPtr(Comp)
        + " state=" + std::to_string(State) + (State == 1 ? "(Bleedout)" : "(None)")
        + " prev=" + std::to_string(PrevState)
        + " duration=" + std::to_string(Duration) + (Duration <= 0.0f ? "  <== ZERO/NEG: SetTimer WILL FAIL" : "")
        + " replacementEffects=" + std::to_string(RepNum) + (RepNum > 0 ? "  <== REPLACEMENT PATH" : "")
        + " finishingHit=" + std::to_string(Finishing)
        + " noHealthEffectHandle=" + std::to_string(NoHealth)
        + " readyForEvents=" + std::to_string(Ready);
}

static BleedoutWatchEntry g_BleedWatch[8]{};

static void BleedoutWatchEnter(void* Comp, float Duration) {
    uint64_t Now = GetTickCount64();
    for (auto& E : g_BleedWatch) if (E.Comp == Comp) { E.EnteredMs = Now; E.DurationAtEntry = Duration; E.Warned = false; return; }
    for (auto& E : g_BleedWatch) if (E.Comp == nullptr) { E = { Comp, Now, Duration, false }; return; }

    BleedoutWatchEntry* Oldest = &g_BleedWatch[0];
    for (auto& E : g_BleedWatch) if (E.EnteredMs < Oldest->EnteredMs) Oldest = &E;
    *Oldest = { Comp, Now, Duration, false };
}

static void BleedoutWatchExit(void* Comp) {
    for (auto& E : g_BleedWatch) if (E.Comp == Comp) { E = {}; return; }
}

static void BleedoutWatchTick() {
    const uint64_t Now = GetTickCount64();

    for (auto& E : g_BleedWatch) {
        if (E.Comp == nullptr || E.Warned) continue;

        const uint64_t HeldMs = Now - E.EnteredMs;

        if (HeldMs < 120000) continue;

        if (!IsReadablePointer(E.Comp, 0x178)) { E = {}; continue; }
        if (*reinterpret_cast<uint8_t*>(reinterpret_cast<uintptr_t>(E.Comp) + 0x0B0) != 1) { E = {}; continue; }

        MpLog("[BleedoutStuck] STILL in bleedout after " + std::to_string(HeldMs / 1000)
            + "s (durationAtEntry=" + std::to_string(E.DurationAtEntry)
            + ") — player is likely stuck downed/invincible. " + BleedoutSnapshot(E.Comp));
        E.Warned = true;
    }
}

void BleedoutNoteEvent(const std::string& FunctionName, void* Obj) {

    if (FunctionName.find("Bleedout") == std::string::npos
        && FunctionName.find("FinishingHit") == std::string::npos
        && FunctionName.find("NoHealth") == std::string::npos) {
        return;
    }

    static const char* kNames[] = {
        "ServerTryStartBleedout", "TryStartBleedout", "AuthSetBleedoutState",
        "AuthOnBleedoutReplaced", "OnRep_CurrentBleedoutState",
        "ReceiveOnEnteredBleedoutState", "ReceiveOnExitedBleedoutState",
        "BroadcastPlayerStartedBleedoutDelegate", "ApplyNoHealthGameplayEffectToSelf",
        "DoFinishingHit", "FailsafeDoFinishingHit", "ClientEndFinishingHit",
        "RegisterBleedoutReplacementEffect", "UnregisterBleedoutReplacementEffect",
        "CanReplaceBleedout", "ReplaceBleedout", "OnPlayerEnterBleedout"
    };

    const char* Hit = nullptr;
    for (const char* N : kNames) {
        if (FunctionName.find(N) != std::string::npos) { Hit = N; break; }
    }
    if (!Hit) return;

    const bool IsComponent = Obj != nullptr
        && reinterpret_cast<UObject*>(Obj)->IsA(SDK::UArchonBleedoutComponent::StaticClass());

    const std::string Snap = IsComponent
        ? BleedoutSnapshot(Obj)
        : ("obj=" + MpPtr(Obj) + " (not the bleedout component — fields not read)");
    MpLog(std::string("[Bleedout] ") + Hit + " | " + Snap);

    if (IsComponent && IsReadablePointer(Obj, 0x178)) {
        const uintptr_t C = reinterpret_cast<uintptr_t>(Obj);
        const uint8_t State = *reinterpret_cast<uint8_t*>(C + 0x0B0);
        const float Duration = *reinterpret_cast<float*>(C + 0x0B4);

        if (State == 1) BleedoutWatchEnter(Obj, Duration);
        else            BleedoutWatchExit(Obj);

        if (State == 1 && Duration <= 0.0f) {
            MpLog("[BleedoutBUG] entered bleedout with duration=" + std::to_string(Duration)
                + " — BleedOutElasped SetTimer will fail and the player will be stuck downed. " + Snap);
        }
    }
}

int GameModeEmptyState() {
    if (!SDK::UObject::GObjects) return -1;
    if (!g_CachedGameMode || !IsReadablePointer(g_CachedGameMode, 0x2E0)) {
        uint64_t Now = GetTickCount64();
        if (Now - g_LastGameModeSearchMs < 3000) return -1;
        g_LastGameModeSearchMs = Now;
        g_CachedGameMode = nullptr;
        const int Count = SDK::UObject::GObjects->Num();
        for (int i = 0; i < Count; i++) {
            SDK::UObject* Obj = SDK::UObject::GObjects->GetByIndex(i);
            if (!Obj || Obj->IsDefaultObject()) continue;
            if (Obj->IsA(SDK::AArchonGameMode::StaticClass())) { g_CachedGameMode = Obj; break; }
        }
    }
    if (!g_CachedGameMode || !IsReadablePointer(g_CachedGameMode, 0x2E0)) return -1;

    g_wdGameModePtr.store(g_CachedGameMode, std::memory_order_relaxed);
    if (g_wdIsHub.load(std::memory_order_relaxed) < 0) {
        SDK::UObject* Cls = *reinterpret_cast<SDK::UObject**>(reinterpret_cast<uintptr_t>(g_CachedGameMode) + 0x10);
        if (Cls && IsReadablePointer(Cls, 0x20)) {
            std::string Name = Cls->GetName();
            g_wdIsHub.store((Name.find("City") != std::string::npos
                             || Name.find("TrainingGrounds") != std::string::npos) ? 1 : 0,
                            std::memory_order_relaxed);
        }
    }
    uintptr_t Gm = reinterpret_cast<uintptr_t>(g_CachedGameMode);
    int32_t NumPlayers    = *reinterpret_cast<int32_t*>(Gm + 0x02D0);
    int32_t NumTravelling = *reinterpret_cast<int32_t*>(Gm + 0x02DC);

    g_wdLastTickMs.store(GetTickCount64(), std::memory_order_relaxed);
    g_wdGameThreadId.store(GetCurrentThreadId(), std::memory_order_relaxed);

    EnsureBleedoutDuration(g_CachedGameMode);
    BleedoutWatchTick();
    if (NumPlayers > 0) g_wdSawPlayer.store(true, std::memory_order_relaxed);

    return (NumPlayers <= 0 && NumTravelling <= 0) ? 1 : 0;
}

static std::atomic<bool> g_emptyWatchdogStarted{ false };

void StartEmptyWatchdogThread() {
    bool expected = false;
    if (!g_emptyWatchdogStarted.compare_exchange_strong(expected, true)) return;
    std::thread([] {
        float emptySec = 0.0f;
        const float POLL_SEC = 2.0f;
        uint64_t iter = 0;
        bool hangSampled = false;
        MpLog("[Watchdog/thread] started (poll 2s; reaps a disposable instance after 50s continuous empty)");
        for (;;) {
            Sleep(static_cast<DWORD>(POLL_SEC * 1000.0f));
            ++iter;
            if (!EnableWatchdog) { emptySec = 0.0f; continue; }

            void* gm  = g_wdGameModePtr.load(std::memory_order_relaxed);
            int   hub = g_wdIsHub.load(std::memory_order_relaxed);
            bool empty = false;
            int32_t numPlayers = -1, numTravelling = -1;
            if (gm && IsReadablePointer(gm, 0x2E0)) {
                numPlayers    = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(gm) + 0x02D0);
                numTravelling = *reinterpret_cast<int32_t*>(reinterpret_cast<uintptr_t>(gm) + 0x02DC);
                empty = (numPlayers <= 0 && numTravelling <= 0);
            }

            if ((iter % 15) == 0 || (empty && hub == 0)) {
                MpLog("[Watchdog/thread] gm=" + MpPtr(gm) + " hub=" + std::to_string(hub)
                    + " numPlayers=" + std::to_string(numPlayers) + " numTravelling=" + std::to_string(numTravelling)
                    + " empty=" + std::to_string(empty ? 1 : 0) + " emptySec=" + std::to_string(emptySec));
            }

            if (empty && hub == 0) {
                emptySec += POLL_SEC;
                if (emptySec >= 50.0f) {
                    MpReapExit("disposable instance empty 50s continuous");
                }
            } else {
                emptySec = 0.0f;
            }

            if (hub == 0 && g_wdSawPlayer.load(std::memory_order_relaxed)) {
                const uint64_t STALE_TICK_MS = 180000;
                uint64_t lastTick = g_wdLastTickMs.load(std::memory_order_relaxed);
                if (lastTick != 0) {
                    uint64_t sinceTick = GetTickCount64() - lastTick;

                    if (sinceTick >= 20000 && !hangSampled) {
                        hangSampled = true;
                        MpLog("[HangSuspect] game thread not ticked for " + std::to_string(sinceTick / 1000)
                            + "s while numPlayers=" + std::to_string(numPlayers)
                            + " — sampling (NOT reaping yet; reap at " + std::to_string(180) + "s)");
                        MpLogHungGameThread();
                    }
                    if (sinceTick < 10000) hangSampled = false;
                    if (sinceTick >= STALE_TICK_MS) {
                        MpLog("[Watchdog/thread] disposable instance tick STALE for "
                            + std::to_string(sinceTick / 1000) + "s (numPlayers=" + std::to_string(numPlayers)
                            + " — hung game thread or ghost connection) -> reap");

                        MpLogHungGameThread();
                        MpReapExit("tick stale");
                    }

                    if (sinceTick >= 60000 && (iter % 15) == 0) {
                        MpLog("[Watchdog/thread] tick stale " + std::to_string(sinceTick / 1000)
                            + "s (numPlayers=" + std::to_string(numPlayers) + "); reaping at "
                            + std::to_string(STALE_TICK_MS / 1000) + "s");
                    }
                }
            }
        }
    }).detach();
}

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
    const float Current = SafeCallPlayerRoleFloat(PlayerRole, 0x01B983E0);
    const float Percent = SafeCallPlayerRoleFloat(PlayerRole, 0x01B98410);
    const float CurrentRate = SafeCallPlayerRoleFloat(PlayerRole, 0x01B98470);
    const float NativeMax = SafeCallPlayerRoleFloat(PlayerRole, 0x01B99F30);

    const int CanActivateNative = SafeCallPlayerRoleBoolRva(PlayerRole, 0x01B8D8A0);
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
        + " canNativeRva=" + MpHex(0x01B8D8A0)
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

std::string SafeObjectNameForDiagnostic(void* Object) {
    if (!Object || !IsReadablePointer(Object, 0x40)) return Object ? "unreadable" : "null";
    return reinterpret_cast<UObject*>(Object)->GetName();
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

static bool IsEscalationFlowFunction(const std::string& FunctionName) {
    const char* Markers[] = {
        "EscalationGameModeComponent.SpawnPlayerBuffChoicesForFinishedRound",
        "EscalationGameModeComponent.OnPlayerActivatedCrystal",
        "EscalationGameModeComponent.PlayerChoseRelic",
        "EscalationGameModeComponent.PlayerEscalationRelicsChanged",
        "EscalationGameModeComponent.RelicSelectedBP",
        "EscalationGameModeComponent.SpawnAllRelics",
        "EscalationGameModeComponent.SpawnRelics",
        "EscalationGameModeComponent.SpawnSpecificRelic",
        "EscalationGameModeComponent.SpawnPersonalBuffPickupsForPlayer",
        "PlayerEscalationComponent.ClientDisplayRelicChoiceUI",
        "PlayerEscalationComponent.OnRep_EscalationRelics",
        "PlayerEscalationComponent.OnShowRelicChoiceScreen",
        "PlayerEscalationComponent.RoundEnded",
        "PlayerEscalationComponent.SelectRelicOption",
        "PlayerEscalationComponent.ServerSelectRelicOption",
        "PlayerEscalationComponent.ServerForceReplication",
        "PlayerEscalationComponent.RelicSelectedNative",
        "PlayerEscalationComponent.OnRelicSelected",
        "escalation_buff_gatherable_bp_C.OnInteractionEnabled",
        "escalation_buff_gatherable_bp_C.OnCrystalActivated",
        "escalation_buff_gatherable_bp_C.Failsafe_EnableInteraction",
        "escalation_buff_gatherable_bp_C.OnUserCanceledInteraction",
        "escalation_buff_gatherable_bp_C.OnUserStartedInteraction",
        "escalation_buff_gatherable_bp_C.OnUserCompletedInteraction",
        "escalation_buff_gatherable_bp_C.AuthEnableInteractable",
        "EscalationRelicChoiceScreen.EnableRelicInteractions",
        "EscalationRelicChoiceScreen.HandleRelicSelected",
        "escalation_relic_choice_screen_C.EnableRelicInteraction",
        "escalation_relic_choice_screen_C.BeginRelicAnimations"
    };
    for (const char* Marker : Markers) {
        if (FunctionName.find(Marker) != std::string::npos) return true;
    }
    return false;
}

static UObject* ResolveEscalationFlowPlayer(UObject* Object, const std::string& FunctionName,
                                            void* Parms, const char* Side) {
    const bool FirstParamIsPlayer =
        FunctionName.find("OnPlayerActivatedCrystal") != std::string::npos
        || FunctionName.find("PlayerChoseRelic") != std::string::npos
        || FunctionName.find("RelicSelectedNative") != std::string::npos
        || FunctionName.find("RelicSelectedBP") != std::string::npos
        || FunctionName.find("SpawnAllRelics") != std::string::npos
        || FunctionName.find("SpawnRelics") != std::string::npos
        || FunctionName.find("SpawnSpecificRelic") != std::string::npos
        || FunctionName.find("SpawnPersonalBuffPickupsForPlayer") != std::string::npos;
    if (FirstParamIsPlayer && Parms && IsReadablePointer(Parms, sizeof(void*))) {
        UObject* Player = *reinterpret_cast<UObject**>(Parms);
        if (Player && IsReadablePointer(Player, 0x258)) return Player;
    }

    if (Object && FunctionName.find("escalation_buff_gatherable_bp_C.") != std::string::npos
        && IsReadablePointer(Object, 0x500)) {
        UObject* Player = *reinterpret_cast<UObject**>(reinterpret_cast<uintptr_t>(Object) + 0x4F8);
        if (Player && IsReadablePointer(Player, 0x258)) return Player;
    }

    UObject* Cursor = Object;
    for (int Depth = 0; Cursor && Depth < 4; ++Depth) {
        if (IsReadablePointer(Cursor, 0x28)
            && Cursor->IsA(SDK::APlayerController::StaticClass())) return Cursor;
        Cursor = IsReadablePointer(Cursor, 0x28) ? Cursor->Outer : nullptr;
    }

    if (Side && strcmp(Side, "Client") == 0 && s_LastPossessedPC
        && IsReadablePointer(s_LastPossessedPC, 0x258)) return s_LastPossessedPC;
    return nullptr;
}

static std::string EscalationArrayState(UObject* Object) {
    if (!Object || !IsReadablePointer(Object, 0x158)
        || !Object->IsA(SDK::UPlayerEscalationComponent::StaticClass())) return "component=n/a";
    const uintptr_t Base = reinterpret_cast<uintptr_t>(Object);
    const int Seasons = SafeReadI32At(Base, 0x128);
    const int SeasonsMax = SafeReadI32At(Base, 0x12C);
    const int Choices = SafeReadI32At(Base, 0x138);
    const int ChoicesMax = SafeReadI32At(Base, 0x13C);
    const int Options = SafeReadI32At(Base, 0x148);
    const int OptionsMax = SafeReadI32At(Base, 0x14C);
    const int Rewards = SafeReadI32At(Base, 0x150);
    return "component=" + MpPtr(Object)
        + " seasons=" + std::to_string(Seasons) + "/" + std::to_string(SeasonsMax)
        + " choices=" + std::to_string(Choices) + "/" + std::to_string(ChoicesMax)
        + " options=" + std::to_string(Options) + "/" + std::to_string(OptionsMax)
        + " roundRewards=" + std::to_string(Rewards);
}

static std::string EscalationFlowParams(const std::string& FunctionName, void* Parms) {
    if (!Parms) return "none";
    const uintptr_t P = reinterpret_cast<uintptr_t>(Parms);
    if (FunctionName.find("ClientDisplayRelicChoiceUI") != std::string::npos) {
        return "relicOptions=" + std::to_string(SafeReadI32At(P, 0x8))
            + " debugChances=" + std::to_string(SafeReadI32At(P, 0x18))
            + " advances=" + std::to_string(SafeReadU8At(P, 0x20));
    }
    if (FunctionName.find("SelectRelicOption") != std::string::npos) {
        std::string RelicId = IsReadablePointer(Parms, 0x8)
            ? reinterpret_cast<SDK::FName*>(Parms)->ToString() : std::string("?");
        return "relicId=" + RelicId + " advances=" + std::to_string(SafeReadU8At(P, 0x8));
    }
    if (FunctionName.find("RelicSelectedNative") != std::string::npos
        || FunctionName.find("RelicSelectedBP") != std::string::npos) {
        return "player=" + MpPtr(*reinterpret_cast<void**>(Parms))
            + " advances=" + std::to_string(SafeReadU8At(P, 0x8));
    }
    if (FunctionName.find("OnPlayerActivatedCrystal") != std::string::npos
        || FunctionName.find("PlayerChoseRelic") != std::string::npos
        || FunctionName.find("SpawnAllRelics") != std::string::npos
        || FunctionName.find("SpawnRelics") != std::string::npos
        || FunctionName.find("SpawnSpecificRelic") != std::string::npos
        || FunctionName.find("SpawnPersonalBuffPickupsForPlayer") != std::string::npos) {
        return "player=" + MpPtr(*reinterpret_cast<void**>(Parms));
    }
    if (FunctionName.find("OnShowRelicChoiceScreen") != std::string::npos
        || FunctionName.find("HandleRelicSelected") != std::string::npos
        || FunctionName.find("OnUserStartedInteraction") != std::string::npos
        || FunctionName.find("OnUserCompletedInteraction") != std::string::npos
        || FunctionName.find("OnUserCanceledInteraction") != std::string::npos) {
        return "arg0=" + MpPtr(*reinterpret_cast<void**>(Parms));
    }
    return "present";
}

static std::string EscalationFlowContext(UObject* Object, const std::string& FunctionName,
                                         void* Parms, const char* Side) {
    UObject* Player = ResolveEscalationFlowPlayer(Object, FunctionName, Parms, Side);
    void* PlayerState = (Player && IsReadablePointer(Player, 0x230))
        ? *reinterpret_cast<void**>(reinterpret_cast<uintptr_t>(Player) + 0x228) : nullptr;
    const std::string PlayerName = (PlayerState && IsReadablePointer(PlayerState, 0x310))
        ? CoreCapFString(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(PlayerState) + 0x300))
        : std::string();
    UObject* Outer = (Object && IsReadablePointer(Object, 0x28)) ? Object->Outer : nullptr;
    return " obj=" + MpPtr(Object) + "/" + SafeObjectNameForDiagnostic(Object)
        + " outer=" + MpPtr(Outer) + "/" + SafeObjectNameForDiagnostic(Outer)
        + " player=" + MpPtr(Player) + "/" + SafeObjectNameForDiagnostic(Player)
        + " playerState=" + MpPtr(PlayerState)
        + " playerName=" + (PlayerName.empty() ? std::string("?") : PlayerName)
        + " state={" + EscalationArrayState(Object) + "}"
        + " params={" + EscalationFlowParams(FunctionName, Parms) + "}";
}

int TraceEscalationFlowEnter(const char* Side, UObject* Object,
                                    const std::string& FunctionName, void* Parms) {
    if (!IsEscalationFlowFunction(FunctionName)) return -1;
    static std::atomic<int> s_EscalationFlowSequence{ 0 };
    const int Seq = s_EscalationFlowSequence.fetch_add(1, std::memory_order_relaxed);
    if (Seq >= 512) return -1;
    MpLog(std::string("[EscalationFlow][") + Side + "][ENTER #" + std::to_string(Seq)
        + "] fn=" + FunctionName + EscalationFlowContext(Object, FunctionName, Parms, Side));
    return Seq;
}

void TraceEscalationFlowExit(const char* Side, int Seq, UObject* Object,
                                   const std::string& FunctionName, void* Parms) {
    if (Seq < 0) return;
    MpLog(std::string("[EscalationFlow][") + Side + "][EXIT #" + std::to_string(Seq)
        + "] fn=" + FunctionName + EscalationFlowContext(Object, FunctionName, Parms, Side));
}

bool CoreCaptureEnabled() {
    static int c = -1;
    if (c < 0) c = MpExeRelativeFlagPresent(L"CORE_CAPTURE.flag") ? 1 : 0;
    return c == 1;
}
