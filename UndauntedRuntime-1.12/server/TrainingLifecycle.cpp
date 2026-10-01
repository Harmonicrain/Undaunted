/*
 * Part of the Undaunted fork (Harmonicrain/Undaunted), October 2026.
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
#include "server/TrainingLifecycle.h"
#include "server/TrainingIdlePolicy.h"
#include "core/RuntimeState.h"
#include "core/Logging.h"
#include "diagnostics/RuntimeDiagnostics.h"

namespace {
// Protocol with UndauntedDeployServer/src/controllers/trainingLease.ts.
constexpr UINT TrainingIdleExitCode = 75;

int IdleSeconds() {
    static const int Seconds = [] {
        const wchar_t* Key = L"-UndauntedTrainingIdleSeconds=";
        const wchar_t* Found = wcsstr(GetCommandLineW(), Key);
        if (!Found) return 0; // Ramsgate, hunts, and clients never opt in.
        const int Value = _wtoi(Found + wcslen(Key));
        return Value >= 60 && Value <= 86400 ? Value : 300;
    }();
    return Seconds;
}

std::wstring LeasePath() {
    wchar_t Path[MAX_PATH]{};
    GetModuleFileNameW(nullptr, Path, MAX_PATH);
    wchar_t* Slash = wcsrchr(Path, L'\\');
    if (!Slash) return {};
    *(Slash + 1) = 0;
    return std::wstring(Path) + L"undaunted-training-" + std::to_wstring(GetCurrentProcessId()) + L".lease";
}

uint64_t UnixMilliseconds() {
    FILETIME Time; GetSystemTimeAsFileTime(&Time);
    ULARGE_INTEGER Value; Value.LowPart = Time.dwLowDateTime; Value.HighPart = Time.dwHighDateTime;
    return Value.QuadPart / 10000 - 11644473600000ull;
}
}

void TickTrainingLifecycle(int32_t Connections) {
    if (!Globals::AmServer || !Globals::Listening || IdleSeconds() == 0) return;
    static TrainingIdlePolicy Idle;
    if (!Idle.EmptyLongEnough(Connections, GetTickCount64(), static_cast<uint64_t>(IdleSeconds()) * 1000)) return;
    static uint64_t NextCheckMs = 0;
    if (GetTickCount64() < NextCheckMs) return;
    NextCheckMs = GetTickCount64() + 1000;
    static const std::wstring Path = LeasePath();
    // This exclusive handle serializes shutdown with a deploy travel reservation.
    // If deploy has it open, leave the world running and try on a later frame.
    HANDLE Lease = CreateFileW(Path.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (Lease == INVALID_HANDLE_VALUE) return;
    char Bytes[32]{}; DWORD Read = 0;
    const bool Ok = ReadFile(Lease, Bytes, sizeof(Bytes) - 1, &Read, nullptr) && Read >= 13 && Read <= 16;
    char* End = nullptr;
    const uint64_t Expiry = _strtoui64(Bytes, &End, 10);
    bool Valid = Ok && End != Bytes && Expiry > 0;
    for (const char* Tail = End; Valid && *Tail; ++Tail) if (*Tail != ' ' && *Tail != '\n' && *Tail != '\r') Valid = false;
    if (!Valid || Expiry > UnixMilliseconds()) { CloseHandle(Lease); return; }
    // Hold the lock through process exit: a late travel request either renews
    // first or observes this closed marker/locked file and waits for a new world.
    if (SetFilePointer(Lease, 0, nullptr, FILE_BEGIN) == INVALID_SET_FILE_POINTER) { CloseHandle(Lease); return; }
    DWORD Written = 0;
    const char Closed[] = "sleeping";
    if (!WriteFile(Lease, Closed, sizeof(Closed) - 1, &Written, nullptr) || Written != sizeof(Closed) - 1
        || !SetEndOfFile(Lease) || !FlushFileBuffers(Lease)) {
        MpLog("[TrainingIdle] could not persist the sleeping marker; leaving the world running");
        CloseHandle(Lease);
        return;
    }
    MpLog("[TrainingIdle] no connections for " + std::to_string(IdleSeconds()) + "s; sleeping until the next travel request");
    MpReapExit("Training Grounds idle sleep", TrainingIdleExitCode);
}
