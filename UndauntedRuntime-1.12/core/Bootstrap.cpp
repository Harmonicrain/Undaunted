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

#include "core/Bootstrap.h"
#include "core/BuildInfo.h"
#include "core/RuntimeState.h"
#include "native/Addresses112.h"
#include "client/ClientHooks.h"
#include "core/Settings.h"
#include "core/Logging.h"
#include "diagnostics/AllocProfile.h"
#include "server/WorldWatchdog.h"
#include "server/RenderData.h"
#include "server/ServerHooks.h"

void MainThread();

static void LogLoadedBuild() {
    HMODULE Module = nullptr;
    char Path[MAX_PATH]{};
    GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS
        | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        reinterpret_cast<LPCSTR>(&LogLoadedBuild), &Module);
    if (Module) GetModuleFileNameA(Module, Path, MAX_PATH);
    MpLog(std::string("[Build] id=") + BuildInfo::Id
        + " mode=" + (Globals::AmServer ? "server" : "client")
        + " module=" + Path);
}

void MainThread() {

    std::string logMsg = "\n=== ParadoxRuntime session start ===\n[MainThread] started. AmServer=";
    logMsg += (Globals::AmServer ? "1" : "0");

    logMsg += " port=";
    logMsg += std::to_string(Globals::Port);

    logMsg += " map=";
    if (Globals::MapPath) {
        logMsg += MpNarrow(std::wstring(Globals::MapPath));
    } else {
        logMsg += "(null)";
    }
    logMsg += " base=";
    logMsg += MpHex(Globals::BaseAddress);

    MpLog(logMsg);

    int waitCount = 0;
    while (true) {

        UWorld* world = UWorld::GetWorld();
        UWorld* directGWorld = nullptr;
        if (Globals::BaseAddress) {
            directGWorld = *reinterpret_cast<UWorld**>(Native112::At(Globals::BaseAddress, Native112::GWorld));
        }
        if (Globals::AmServer) {
            MpLog("[MainThread] wait=" + std::to_string(waitCount)
                + " SDKWorld=" + MpPtr(world)
                + " DirectGWorld=" + MpPtr(directGWorld));
        }

        if (world || directGWorld) break;

        if (Globals::AmServer) {

            Sleep(1000);

            waitCount++;

            if (waitCount >= 30) {

                break;
            }
        }
        else {
            Sleep(1);
        }
    }

    if (Globals::AmServer) {
        MpLog("[MainThread] UWorld is live; requesting listen immediately");
        Globals::DoListen = true;
        return;
    }

    Sleep(3 * 1000);

    UEngine* Engine = UEngine::GetEngine();

    UInputSettings::GetDefaultObj()->ConsoleKeys[0].KeyName = UKismetStringLibrary::Conv_StringToName(L"F2");

    UObject* NewObject = UGameplayStatics::SpawnObject(Engine->ConsoleClass, Engine->GameViewport);

    Engine->GameViewport->ViewportConsole = static_cast<UConsole*>(NewObject);

    if (Globals::EnableLogging)
        std::cout << "Spawned UConsole!" << std::endl;
}

void Init() {

    Globals::AmServer = std::string(GetCommandLineA()).contains("-server");
    Globals::BaseAddress = (uintptr_t)GetModuleHandleA(nullptr);

    if (Globals::AmServer) {
        *(uint8_t*)(Native112::At(Globals::BaseAddress, Native112::GIsServer)) = 0x1;
        *(uint8_t*)(Native112::At(Globals::BaseAddress, Native112::GIsClient)) = 0x0;
    }

    if (Globals::AmServer) {
        int NumArgs = 0;

        wchar_t** Args = CommandLineToArgvW(GetCommandLineW(), &NumArgs);

        if (NumArgs > 8) {

            Globals::ServerAPIKeyStorage = Args[1];
            Globals::MapPathStorage = Args[3];
            Globals::BehemothPathStorage = Args[4];
            Globals::MatchmakerHuntIdStorage = Args[5];
            Globals::ExpectedPlayerStringStorage = Args[6];
            Globals::MyIpAndPortStorage = Args[7];
            if (NumArgs > 9 && Args[8][0] != L'-') Globals::MetagameAddress = Args[8];

            Globals::ServerAPIKey = Globals::ServerAPIKeyStorage.c_str();
            Globals::Port = std::stoi(std::wstring(Args[2]));
            Globals::MapPath = Globals::MapPathStorage.c_str();
            Globals::BehemothPath = Globals::BehemothPathStorage.c_str();
            Globals::MatchmakerHuntId = Globals::MatchmakerHuntIdStorage.c_str();
            Globals::ExpectedPlayerString = Globals::ExpectedPlayerStringStorage.c_str();
            Globals::MyIpAndPort = Globals::MyIpAndPortStorage.c_str();

            if (Globals::Port >= 8776) {

                EnableWatchdog = true;
                Globals::EnableLogging = true;
            }
        }
        else {

            std::string cmdLine = GetCommandLineA();

            Globals::Port = 8777;
            static std::wstring DefaultMapPath = L"Ramsgate";
            Globals::MapPath = DefaultMapPath.c_str();
            Globals::EnableLogging = true;
            EnableWatchdog = false;

            size_t portPos = cmdLine.find("Port=");
            if (portPos != std::string::npos) {
                int parsedPort = std::stoi(cmdLine.substr(portPos + 5));
                if (parsedPort > 0) {
                    Globals::Port = parsedPort;

                }
            }

            size_t mapStart = cmdLine.find_first_not_of(" \t", cmdLine.find_first_of(" \t") + 1);
            if (mapStart != std::string::npos && cmdLine[mapStart] != '-') {
                size_t mapEnd = cmdLine.find_first_of("? \t", mapStart);
                if (mapEnd != std::string::npos) {
                    std::string mapName = cmdLine.substr(mapStart, mapEnd - mapStart);
                    static std::wstring parsedMapPath = std::wstring(mapName.begin(), mapName.end());
                    Globals::MapPath = parsedMapPath.c_str();

                }
            }

            std::string mapStr;
            if (Globals::MapPath) {
                for (const wchar_t* p = Globals::MapPath; *p; ++p) mapStr += (char)*p;
            }

        }

        LogLoadedBuild();
        Settings::LogActive();
        StartServerRenderDataOptions();
        InitServerHooks();
        StartAllocProfile();

    }
    else {
        Globals::EnableLogging = true;

        int NumArgs = 0;
        wchar_t** Args = CommandLineToArgvW(GetCommandLineW(), &NumArgs);
        // With -log, give the client a console before the engine starts so its
        // log output is readable (as the 1.4.4 runtime does).
        for (int i = 1; Args && i < NumArgs; ++i) {
            if (_wcsicmp(Args[i], L"-log") == 0) {
                AllocConsole();
                FILE* Dummy;
                freopen_s(&Dummy, "CONOUT$", "w", stdout);
                freopen_s(&Dummy, "CONOUT$", "w", stderr);
                // Wide, deep buffer so long log lines and a whole session survive.
                COORD Size{ 400, 32000 };
                SetConsoleScreenBufferSize(GetStdHandle(STD_OUTPUT_HANDLE), Size);
                break;
            }
        }
        if (Settings::Has(L"Metagame")) Globals::MetagameAddress = Settings::Text(L"Metagame");

        LogLoadedBuild();
        Settings::LogActive();
        InitClientHooks();
    }

    DWORD threadId;
    CreateThread(nullptr, 0x1000, (LPTHREAD_START_ROUTINE)MainThread, nullptr, 0, &threadId);

}
