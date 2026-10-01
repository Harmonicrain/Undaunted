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

#include "diagnostics/HangTrace.h"
#include "core/RuntimeState.h"
#include "native/Addresses112.h"
#include "core/Logging.h"
#include "core/Memory.h"
#include "core/Settings.h"

// The game thread's current ProcessEvent call, and with -UndauntedDiag=verbose
// the names of its last calls, kept for LogHungGameThread.
char           g_gtPeNameRing[kPeRing][160] = {};
std::atomic<uint32_t> g_gtPeRingPos{ 0 };
std::atomic<void*>    g_gtPeCurFunc{ nullptr };
std::atomic<void*>    g_gtPeCurObj{ nullptr };

void NoteGameThreadEvent(void* Function, void* Object, const std::string& FunctionName) {
    const DWORD GameThread = GameTickThreadId;
    if (GameThread != 0 && GetCurrentThreadId() != GameThread) return;
    g_gtPeCurFunc.store(Function, std::memory_order_relaxed);
    g_gtPeCurObj.store(Object, std::memory_order_relaxed);
    static const bool Verbose = Settings::Diag(L"verbose");
    if (Verbose) {
        const uint32_t Slot = g_gtPeRingPos.fetch_add(1, std::memory_order_relaxed) % kPeRing;
        strncpy_s(g_gtPeNameRing[Slot], sizeof(g_gtPeNameRing[Slot]), FunctionName.c_str(), _TRUNCATE);
    }
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

void LogHungGameThread() {
    const uint32_t Tid = GameTickThreadId;
    if (Tid == 0) { MpLog("[HangTrace] game thread id unknown; cannot sample"); return; }

    HANDLE Th = OpenThread(THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION | THREAD_SUSPEND_RESUME, FALSE, Tid);
    if (!Th) { MpLog("[HangTrace] OpenThread failed for tid=" + std::to_string(Tid)); return; }

    uint64_t rip[3] = { 0,0,0 };
    uint64_t rsp0 = 0;
    uint64_t retChain[12] = {};
    int      retN = 0;
    CONTEXT  fullCtx0{};
    bool     haveCtx0 = false;
    const uint64_t codeLo = Native112::At(Globals::BaseAddress, Native112::CodeStart);
    const uint64_t codeHi = Native112::At(Globals::BaseAddress, Native112::CodeEnd);

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
