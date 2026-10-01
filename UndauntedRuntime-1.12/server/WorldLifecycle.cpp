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

#include "server/WorldLifecycle.h"
#include "core/RuntimeState.h"
#include "native/Addresses112.h"
#include "core/Logging.h"
#include "core/Memory.h"
#include "core/Settings.h"

struct RawPointerArray { void** Data; int32_t Num; int32_t Max; };

static int HubMaxPlayers();

void* OrigGetDefaultMap = nullptr;

void* OrigNetModeHook = nullptr;

void* OrigInternalNetModeHook = nullptr;

void* OrigWorldNetModeHook = nullptr;


void* OrigIsNetReady = nullptr;

static int HubMaxPlayers() {
    static int Cached = -1;
    if (Cached < 0) {
        Cached = 4;
        wchar_t ExePath[MAX_PATH];
        DWORD n = GetModuleFileNameW(nullptr, ExePath, MAX_PATH);
        if (n > 0 && n < MAX_PATH) {
            for (int i = (int)n - 1; i >= 0; --i) {
                if (ExePath[i] == L'\\' || ExePath[i] == L'/') { ExePath[i + 1] = L'\0'; break; }
            }
            std::wstring Path = std::wstring(ExePath) + L"HUB_MAX_PLAYERS.txt";
            std::ifstream File(Path);
            if (File.is_open()) {
                int Value = 0;
                if ((File >> Value) && Value >= 1 && Value <= 64) { Cached = Value; }
            }
        }
    }
    return Cached;
}

FString* GetGameDefaultMap(FString* a1) {

    static const bool Verbose = Settings::Diag(L"verbose");
    if (Verbose) MpLog("[GetGameDefaultMap] entry out=" + MpPtr(a1));
    FString* Ret = reinterpret_cast<FString*(*)(FString*)>(OrigGetDefaultMap)(a1);
    if (Verbose) MpLog("[GetGameDefaultMap] original returned " + MpPtr(Ret));

    std::wstring FinalURL(Globals::MapPath);

    std::wstring BehemothPath(Globals::BehemothPath);

    if (!BehemothPath.contains(L"NO_BEHEMOTH")) {
        FinalURL += std::wstring(L"?MonsterClass=");
        FinalURL += std::wstring(BehemothPath);
    }

    std::wstring MatchmakerHuntId(Globals::MatchmakerHuntId);

    if (!MatchmakerHuntId.contains(L"NO_MM_HUNTID")) {
        FinalURL += std::wstring(L"?HuntId=");
        FinalURL += std::wstring(MatchmakerHuntId);
    }

    std::wstring ExpectedPlayers(Globals::ExpectedPlayerString);

    if (!ExpectedPlayers.contains(L"NO_EXPECTED_PLAYERS")) {
        FinalURL += std::wstring(L"?PlayerHuntIds=");
        FinalURL += std::wstring(ExpectedPlayers);
    }

    FinalURL += std::wstring(L"?MaxPlayers=");
    FinalURL += std::to_wstring(HubMaxPlayers());

    {
        struct RawFString { wchar_t* Data; int Num; int Max; };
        RawFString* Raw = reinterpret_cast<RawFString*>(Ret);
        const int Count = static_cast<int>(FinalURL.size()) + 1;
        MpLog("[GetGameDefaultMap] setting map URL (" + std::to_string(FinalURL.size()) + " chars): " + MpNarrow(FinalURL));
        MpLog("[GetGameDefaultMap] before write Ret=" + MpPtr(Ret)
            + " Data=" + MpPtr(Raw->Data)
            + " Num=" + std::to_string(Raw->Num)
            + " Max=" + std::to_string(Raw->Max)
            + " Count=" + std::to_string(Count));

        if (Raw->Max < Count || Raw->Data == nullptr) {
            MpLog("[GetGameDefaultMap] realloc needed");
            Raw->Data = static_cast<wchar_t*>(EngineRealloc(Raw->Data, static_cast<size_t>(Count) * sizeof(wchar_t)));
            MpLog("[GetGameDefaultMap] realloc returned Data=" + MpPtr(Raw->Data));
        }
        else {
            MpLog("[GetGameDefaultMap] reusing existing buffer");
        }

        if (!Raw->Data) {
            MpLog("[GetGameDefaultMap] null Data after allocation; returning original result");
            return Ret;
        }

        wmemcpy(Raw->Data, FinalURL.c_str(), static_cast<size_t>(Count));
        Raw->Num = Count;
        if (Raw->Max < Count) {
            Raw->Max = Count;
        }
        MpLog("[GetGameDefaultMap] written OK Data=" + MpPtr(Raw->Data)
            + " Num=" + std::to_string(Raw->Num)
            + " Max=" + std::to_string(Raw->Max));
    }

    return Ret;
}

void* OrigGetCommandLine = nullptr;

const wchar_t* GetCommandLineHook() {

    return L"Dauntless-Win64-Shipping.exe -server -unattended -nullrhi -warp -nosound -EpicPortal -NoEAC -RepDriverDisable -LogCmds=\"LogNet VeryVerbose, LogNetPackageMap Verbose\"";
}

void* OrigServerBootCrash = nullptr;

void ServerBootCrash(void* param_1) {
    const wchar_t* ErrorHist = *reinterpret_cast<const wchar_t**>(Native112::At(Globals::BaseAddress, Native112::GErrorHist));

    std::string Category = "ServerBootCrash";
    std::string MsgNarrow = ErrorHist ? MpNarrow(std::wstring(ErrorHist)) : std::string("(null error history buffer)");

    MpLog("[ServerBootCrash] SUPPRESSED FATAL - category=" + Category + " msg=" + MsgNarrow);

    (void)param_1;
    return;
}

void* OrigArchonLoadManagerLoadFailed = nullptr;

void ArchonLoadManagerLoadFailedHook(void* This) {

    static std::atomic<int> s_hitCount{0};
    int hit = s_hitCount.fetch_add(1, std::memory_order_relaxed);

    uintptr_t self = reinterpret_cast<uintptr_t>(This);
    MpLog(std::string("[LoadFailedDiag] fire #") + std::to_string(hit)
        + " LoadManager=" + MpPtr(This));

    if (!IsReadablePointer(This, 0x60)) {
        MpLog("[LoadFailedDiag]   LoadManager pointer not readable, skipping enumeration");
        return;
    }

    uintptr_t arrayBase = SafeReadPtr(self, 0x48);
    int32_t   arrayCount = SafeReadI32At(self, 0x50);

    MpLog(std::string("[LoadFailedDiag]   ArrayBase=") + MpPtr((void*)arrayBase)
        + " Count=" + std::to_string(arrayCount));

    if (!arrayBase || arrayCount <= 0 || arrayCount > 128) {
        MpLog("[LoadFailedDiag]   Array empty/invalid, skipping enumeration");
        return;
    }

    if (!IsReadablePointer(reinterpret_cast<void*>(arrayBase),
                           static_cast<size_t>(arrayCount) * 0x10)) {
        MpLog("[LoadFailedDiag]   Array memory not readable at expected size");
        return;
    }

    for (int i = 0; i < arrayCount; ++i) {
        uintptr_t entryAddr = arrayBase + static_cast<uintptr_t>(i) * 0x10;

        int32_t  fnameComp = SafeReadI32At(entryAddr, 0x00);
        int32_t  fnameNum  = SafeReadI32At(entryAddr, 0x04);
        uintptr_t objPtr   = SafeReadPtr(entryAddr, 0x08);

        int loadedFlag = -1;
        if (objPtr && IsReadablePointer(reinterpret_cast<void*>(objPtr), 0x40)) {
            loadedFlag = SafeReadU8At(objPtr, 0x10);
        }

        std::string loaderName = "(no name)";
        if (fnameComp > 0 && fnameComp < 0x100000 ) {
            FName resolved{fnameComp, static_cast<uint32_t>(fnameNum)};
            loaderName = resolved.ToString();
        } else {
            char rawBuf[64];
            _snprintf_s(rawBuf, sizeof(rawBuf), _TRUNCATE,
                        "(FName idx=%d num=%d)", fnameComp, fnameNum);
            loaderName = rawBuf;
        }

        MpLog(std::string("[LoadFailedDiag]   [") + std::to_string(i) + "] "
            + "name=" + loaderName
            + " obj="  + MpPtr((void*)objPtr)
            + " loaded=" + std::to_string(loadedFlag)
            + " fname=(" + std::to_string(fnameComp) + "," + std::to_string(fnameNum) + ")");
    }

    (void)This;
    return;
}



bool SanitizeNetDriverClientConnections(void* NetDriver, const char* Tag) {
    if (!NetDriver || !IsReadablePointer(NetDriver, 0xA0)) {
        MpLog(std::string("[") + Tag + "] invalid NetDriver=" + MpPtr(NetDriver));
        return false;
    }

    RawPointerArray* ClientConnections = reinterpret_cast<RawPointerArray*>(
        reinterpret_cast<uintptr_t>(NetDriver) + 0x90);

    if (!IsReadablePointer(ClientConnections, sizeof(RawPointerArray))) {
        MpLog(std::string("[") + Tag + "] unreadable ClientConnections metadata NetDriver=" + MpPtr(NetDriver));
        return false;
    }

    if (!IsSanePointerArray(ClientConnections->Data, ClientConnections->Num, ClientConnections->Max, 1024)) {
        MpLog(std::string("[") + Tag + "] resetting invalid ClientConnections"
            + " data=" + MpPtr(ClientConnections->Data)
            + " num=" + std::to_string(ClientConnections->Num)
            + " max=" + std::to_string(ClientConnections->Max));
        ClientConnections->Data = nullptr;
        ClientConnections->Num = 0;
        ClientConnections->Max = 0;
        return false;
    }

    int32_t WriteIndex = 0;
    for (int32_t ReadIndex = 0; ReadIndex < ClientConnections->Num; ++ReadIndex) {
        void* Connection = ClientConnections->Data[ReadIndex];
        if (!IsReadablePointer(Connection, 0x138)) {
            MpLog(std::string("[") + Tag + "] dropping invalid connection"
                + " index=" + std::to_string(ReadIndex)
                + " ptr=" + MpPtr(Connection));
            continue;
        }

        ClientConnections->Data[WriteIndex++] = Connection;
    }

    for (int32_t Index = WriteIndex; Index < ClientConnections->Num; ++Index) {
        ClientConnections->Data[Index] = nullptr;
    }

    if (WriteIndex != ClientConnections->Num) {
        MpLog(std::string("[") + Tag + "] compacted ClientConnections"
            + " oldNum=" + std::to_string(ClientConnections->Num)
            + " newNum=" + std::to_string(WriteIndex));
        ClientConnections->Num = WriteIndex;
        return false;
    }

    RawPointerArray* PendingCleanup = reinterpret_cast<RawPointerArray*>(
        reinterpret_cast<uintptr_t>(NetDriver) + 0xF0);

    if (!IsReadablePointer(PendingCleanup, sizeof(RawPointerArray))) {
        MpLog(std::string("[") + Tag + "] unreadable NetDriver+0xF0 cleanup metadata NetDriver=" + MpPtr(NetDriver));
        return false;
    }

    if (PendingCleanup->Num < 0 || PendingCleanup->Max < 0 ||
        PendingCleanup->Num > PendingCleanup->Max || PendingCleanup->Num > 1024 ||
        (PendingCleanup->Num > 0 && !IsReadablePointer(PendingCleanup->Data, static_cast<size_t>(PendingCleanup->Num) * 0x18))) {
        MpLog(std::string("[") + Tag + "] resetting invalid cleanup array"
            + " data=" + MpPtr(PendingCleanup->Data)
            + " num=" + std::to_string(PendingCleanup->Num)
            + " max=" + std::to_string(PendingCleanup->Max));
        PendingCleanup->Data = nullptr;
        PendingCleanup->Num = 0;
        PendingCleanup->Max = 0;
        return false;
    }

    return true;
}

void* OrigNetDriverTickDispatchInner = nullptr;

void NetDriverTickDispatchInnerHook(void* NetDriver, float DeltaTime) {
    if (!SanitizeNetDriverClientConnections(NetDriver, "NetDriverTickDispatchInner")) {
        MpLog("[NetDriverTickDispatchInner] skipped original after sanitizing unsafe connection state");
        return;
    }

    reinterpret_cast<void(*)(void*, float)>(OrigNetDriverTickDispatchInner)(NetDriver, DeltaTime);
}

void* OrigNotifyClientDisconnected = nullptr;

void NotifyClientDisconnectedHook(void* NetDriver, void* Connection) {
    MpLog("[NotifyClientDisconnected] hook entry");

    if (!NetDriver || !IsReadablePointer(NetDriver, 0x240)) {
        MpLog("[NotifyClientDisconnected] invalid NetDriver pointer");
        return;
    }

    if (Connection && !IsReadablePointer(Connection, 0x140)) {
        MpLog("[NotifyClientDisconnected] skipping invalid connection pointer");
        return;
    }

    RawPointerArray* DisconnectedClients = reinterpret_cast<RawPointerArray*>(
        reinterpret_cast<uintptr_t>(NetDriver) + 0x238);

    if (!IsSanePointerArray(DisconnectedClients->Data, DisconnectedClients->Num, DisconnectedClients->Max, 1024)) {
        MpLog("[NotifyClientDisconnected] invalid NetDriver+0x238 array; skipping original");
        return;
    }

    for (int32_t Index = 0; Index < DisconnectedClients->Num; ++Index) {
        if (DisconnectedClients->Data[Index] != Connection) {
            continue;
        }

        const int32_t LastIndex = DisconnectedClients->Num - 1;
        if (Index != LastIndex) {
            DisconnectedClients->Data[Index] = DisconnectedClients->Data[LastIndex];
        }
        DisconnectedClients->Data[LastIndex] = nullptr;
        DisconnectedClients->Num = LastIndex;
        MpLog("[NotifyClientDisconnected] removed connection from NetDriver+0x238");
        return;
    }

    MpLog("[NotifyClientDisconnected] connection not present in NetDriver+0x238");
}
