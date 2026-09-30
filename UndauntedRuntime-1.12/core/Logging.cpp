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

#include "core/Logging.h"
#include "core/RuntimeState.h"
#include "native/Addresses112.h"

static const char* MpLogDir();
static std::string MpBaseName(const char* Path);

static char g_MpLogDir[MAX_PATH] = { 0 };

static volatile LONG g_MpLogDirReady = 0;

static const char* MpLogDir() {
    if (g_MpLogDirReady == 0) {
        char ExePath[MAX_PATH];
        DWORD n = GetModuleFileNameA(nullptr, ExePath, MAX_PATH);
        if (n > 0 && n < MAX_PATH) {
            int slash = -1;
            for (DWORD i = 0; i < n; ++i) { if (ExePath[i] == '\\' || ExePath[i] == '/') { slash = (int)i; } }
            if (slash >= 0) {
                for (int i = 0; i <= slash; ++i) { g_MpLogDir[i] = ExePath[i]; }
                g_MpLogDir[slash + 1] = '\0';
            }
        }
        InterlockedExchange(&g_MpLogDirReady, 1);
    }
    return g_MpLogDir;
}

void WriteRuntimeLog(int Port, const std::string& Msg, bool Stamped) {
    char Path[MAX_PATH];
    sprintf_s(Path, "%smysticparadox_dll_port%d.log", MpLogDir(), Port);

    std::ofstream File(Path, std::ios::app);

    if (File.is_open()) {
        if (Stamped) {
            SYSTEMTIME Now{};
            GetLocalTime(&Now);
            File << "["
                 << std::setfill('0') << std::setw(2) << Now.wHour << ":"
                 << std::setfill('0') << std::setw(2) << Now.wMinute << ":"
                 << std::setfill('0') << std::setw(2) << Now.wSecond << "."
                 << std::setfill('0') << std::setw(3) << Now.wMilliseconds << "] "
                 << "pid=" << GetCurrentProcessId() << " ";
        }
        File << Msg << "\n";
        File.flush();
    }
}

std::string MpNarrow(const std::wstring& W) {
    std::string Out;
    Out.reserve(W.size());
    for (wchar_t Ch : W) {
        Out.push_back(static_cast<char>(Ch));
    }
    return Out;
}

std::string MpPtr(const void* Ptr) {
    return Ptr ? std::to_string(reinterpret_cast<uintptr_t>(Ptr)) : "null";
}

std::string MpHex(uintptr_t Value) {
    std::ostringstream Stream;
    Stream << "0x" << std::uppercase << std::hex << Value;
    return Stream.str();
}

std::string DumpBytesHex(const void* Ptr, size_t Count) {
    std::ostringstream Stream;
    const uint8_t* Bytes = reinterpret_cast<const uint8_t*>(Ptr);
    Stream << std::uppercase << std::hex << std::setfill('0');
    for (size_t i = 0; i < Count; ++i) {
        if (i) Stream << ' ';
        Stream << std::setw(2) << static_cast<unsigned>(Bytes[i]);
    }
    return Stream.str();
}

static std::string MpBaseName(const char* Path) {
    if (!Path || !Path[0]) {
        return "(unknown)";
    }

    const char* Base = Path;
    for (const char* Cursor = Path; *Cursor; ++Cursor) {
        if (*Cursor == '\\' || *Cursor == '/') {
            Base = Cursor + 1;
        }
    }

    return std::string(Base);
}

std::string MpAddress(const void* Ptr) {
    if (!Ptr) {
        return "null";
    }

    HMODULE Module = nullptr;
    if (GetModuleHandleExA(
        GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        reinterpret_cast<LPCSTR>(Ptr),
        &Module)) {
        char ModulePath[MAX_PATH]{};
        GetModuleFileNameA(Module, ModulePath, MAX_PATH);
        uintptr_t Base = reinterpret_cast<uintptr_t>(Module);
        uintptr_t Address = reinterpret_cast<uintptr_t>(Ptr);
        return MpBaseName(ModulePath) + "+" + MpHex(Address - Base);
    }

    uintptr_t Base = Globals::BaseAddress ? Globals::BaseAddress : reinterpret_cast<uintptr_t>(GetModuleHandleA(nullptr));
    uintptr_t Address = reinterpret_cast<uintptr_t>(Ptr);
    if (Base && Address >= Base && Address < Base + 0x08000000) {
        return "Dauntless-Win64-Shipping.exe+" + MpHex(Address - Base);
    }

    return MpHex(Address);
}

void MpLog(const std::string& Msg) {
    WriteRuntimeLog(Globals::Port, Msg);
}
