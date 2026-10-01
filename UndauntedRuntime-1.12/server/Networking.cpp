/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Further modified in October 2026 for the Undaunted fork (Harmonicrain/Undaunted):
 * the manual actor-replication loop and its switches were removed (the game's
 * own replication graph replicates), and diagnostics use the runtime settings.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#include "server/Networking.h"
#include "core/Memory.h"
#include "core/Logging.h"
#include "core/Settings.h"
#include "native/Addresses112.h"

#include <fstream>
#include <iostream>
#include <string>

using namespace SDK;

namespace Networking {
    UNetDriver* NetDriver = nullptr;

    static uintptr_t BaseAddress = 0x0;
    static int LastPort = 0; 

    // Stamped with the time and process like the rest of the runtime's log.
    static void NetLog(int Port, const std::string& Msg) {
        WriteRuntimeLog(Port, Msg, true);
    }

    static bool RepGraphDiag() {
        static const bool Enabled = Settings::Diag(L"repgraph");
        return Enabled;
    }

    static UActorChannel* GetActorChannelForConnectionAndActor(UNetConnection* Connection, AActor* Actor) {
        if (!IsReadablePointer(Connection, 0x80)) {
            return nullptr;
        }

        UChannel** Channels = *reinterpret_cast<UChannel***>((uintptr_t)Connection + 0x70);
        int32_t ChannelCount = *reinterpret_cast<int32_t*>((uintptr_t)Connection + 0x78);
        int32_t ChannelMax = *reinterpret_cast<int32_t*>((uintptr_t)Connection + 0x7C);

        if (!IsSanePointerArray(Channels, ChannelCount, ChannelMax, 4096)) {
            NetLog(LastPort, "[GetActorChannel] Invalid OpenChannels array; skipping");
            return nullptr;
        }

        for (int32_t i = 0; i < ChannelCount; ++i) {
            UChannel* Channel = Channels[i];
            if (!IsReadablePointer(Channel, 0x78)) {
                continue;
            }

            if (Channel->Class == UActorChannel::StaticClass() && ((UActorChannel*)Channel)->Actor == Actor) {
                return ((UActorChannel*)Channel);
            }
        }

        return nullptr;
    }

    int BootstrapActorChannel(AActor* Actor, UNetConnection* Connection) {
        if (!Actor || !Connection || !IsReadablePointer(Actor, 0x100)
            || !IsReadablePointer(Connection, 0x140)) {
            return 0;
        }

        UActorChannel* ActorChannel = GetActorChannelForConnectionAndActor(Connection, Actor);
        const bool ExistingChannel = ActorChannel != nullptr;

        static FName ActorChannelName = FName();
        static bool ActorChannelNameInitialized = false;
        if (!ActorChannelNameInitialized) {
            ActorChannelName = UKismetStringLibrary::Conv_StringToName(L"Actor");
            ActorChannelNameInitialized = true;
        }

        if (!ActorChannel) {

            ActorChannel = reinterpret_cast<UActorChannel * (*)(UNetConnection*, FName*, unsigned int, int)>(
                BaseAddress + Native112::CreateActorChannel)(Connection, &ActorChannelName, 1 << 1, -1);
            if (ActorChannel) {
                reinterpret_cast<void(*)(UActorChannel*, AActor*, unsigned int)>(
                    BaseAddress + Native112::SetChannelActor)(ActorChannel, Actor, 0);
            }
        }

        if (!ActorChannel || ActorChannel->Actor != Actor) {
            NetLog(LastPort, "[PlayerRoleDirectChannel] actor="
                + std::to_string(reinterpret_cast<uintptr_t>(Actor)) + " conn="
                + std::to_string(reinterpret_cast<uintptr_t>(Connection))
                + " result=CREATE_FAILED");
            return 0;
        }

        const bool WroteData = reinterpret_cast<bool(*)(UActorChannel*)>(
            BaseAddress + Native112::ActorChannelReplicateActor)(ActorChannel);
        NetLog(LastPort, "[PlayerRoleDirectChannel] actor="
            + std::to_string(reinterpret_cast<uintptr_t>(Actor)) + " conn="
            + std::to_string(reinterpret_cast<uintptr_t>(Connection)) + " channel="
            + std::to_string(reinterpret_cast<uintptr_t>(ActorChannel)) + " result="
            + (ExistingChannel ? std::string("EXISTING") : std::string("CREATED"))
            + " wroteData=" + std::to_string(WroteData ? 1 : 0));
        return WroteData ? (ExistingChannel ? 3 : 2) : 1;
    }

    static FWorldContext* ResolveWorldContextFromWorld(UEngine* Engine, UWorld* World) {
        if (!Engine || !World) {
            return nullptr;
        }

        FWorldContext** WorldList = *reinterpret_cast<FWorldContext***>((uintptr_t)Engine + 0xC38);
        int32_t WorldListCount = *reinterpret_cast<int32_t*>((uintptr_t)Engine + 0xC40);

        for (int32_t i = 0; i < WorldListCount; ++i) {
            FWorldContext* Context = WorldList[i];
            if (!Context) {
                continue;
            }

            UWorld* ContextWorld = *reinterpret_cast<UWorld**>((uintptr_t)Context + 0x280);
            if (ContextWorld == World) {
                return Context;
            }
        }

        return nullptr;
    }

    static UNetDriver* ResolveNamedNetDriver(FWorldContext* Context, const FName& DriverName) {
        if (!Context) {
            return nullptr;
        }

        auto ActiveNetDrivers = *reinterpret_cast<uint8_t**>((uintptr_t)Context + 0x220);
        int32_t ActiveNetDriverCount = *reinterpret_cast<int32_t*>((uintptr_t)Context + 0x228);
        int32_t ActiveNetDriverMax = *reinterpret_cast<int32_t*>((uintptr_t)Context + 0x22C);

        if (ActiveNetDriverCount < 0 || ActiveNetDriverCount > ActiveNetDriverMax || ActiveNetDriverMax > 128) {
            NetLog(LastPort, "[ResolveNamedNetDriver] Invalid ActiveNetDrivers array metadata");
            return nullptr;
        }

        if (ActiveNetDriverCount > 0 && !IsReadablePointer(ActiveNetDrivers, static_cast<size_t>(ActiveNetDriverCount) * 0x10)) {
            NetLog(LastPort, "[ResolveNamedNetDriver] ActiveNetDrivers data is not readable");
            return nullptr;
        }

        for (int32_t i = 0; i < ActiveNetDriverCount; ++i) {
            UNetDriver* Candidate = *reinterpret_cast<UNetDriver**>(ActiveNetDrivers + (static_cast<size_t>(i) * 0x10));
            if (!IsReadablePointer(Candidate, 0x2B0)) {
                continue;
            }

            if (!Candidate->IsA(SDK::UNetDriver::StaticClass())) {
                continue;
            }

            if (Candidate->NetDriverName == DriverName) {
                return Candidate;
            }
        }

        return nullptr;
    }

    static UNetDriver* FindNamedNetDriverInGObjects(const FName& DriverName) {
        for (int i = 0; i < SDK::UObject::GObjects->Num(); i++)
        {
            SDK::UObject* Obj = SDK::UObject::GObjects->GetByIndex(i);

            if (!Obj || Obj->IsDefaultObject()) {
                continue;
            }

            if (Obj->IsA(SDK::UNetDriver::StaticClass()))
            {
                UNetDriver* Candidate = (UNetDriver*)Obj;
                if (!IsReadablePointer(Candidate, 0x2B0)) {
                    continue;
                }

                if (Candidate->NetDriverName == DriverName) {
                    return Candidate;
                }
            }
        }

        return nullptr;
    }

    void Listen(UEngine* Engine, int Port) {
        NetLog(Port, "[Networking::Listen] Entry");
        LastPort = Port;
        BaseAddress = (uintptr_t)GetModuleHandleA(nullptr);

        FName GameNetDriver = UKismetStringLibrary::Conv_StringToName(L"GameNetDriver");
        NetLog(Port, "[Networking::Listen] Creating NetDriver...");

        UWorld* World = UWorld::GetWorld();
        FWorldContext* WorldContext = ResolveWorldContextFromWorld(Engine, World);
        if (!WorldContext) {
            NetLog(Port, "[Networking::Listen] ERROR: FWorldContext not found");
            return;
        }

        using CreateNamedNetDriverFn = bool (*)(UEngine*, FWorldContext*, FName, FName);
        bool Created = reinterpret_cast<CreateNamedNetDriverFn>(BaseAddress + Native112::CreateNamedNetDriver)(
            Engine,
            WorldContext,
            GameNetDriver,
            GameNetDriver
        );
        NetLog(Port, std::string("[Networking::Listen] CreateNamedNetDriver returned ") + (Created ? "true" : "false"));

        NetDriver = ResolveNamedNetDriver(WorldContext, GameNetDriver);
        if (!NetDriver) {
            NetLog(Port, "[Networking::Listen] ActiveNetDrivers lookup failed; searching GObjects for named NetDriver");
            NetDriver = FindNamedNetDriverInGObjects(GameNetDriver);
        }

        if (!NetDriver) {
            NetLog(Port, "[Networking::Listen] ERROR: named NetDriver not found");
            return;
        }

        NetLog(Port, "[Networking::Listen] NetDriver found at 0x" + std::to_string((uintptr_t)NetDriver));
        NetDriver->NetDriverName = GameNetDriver;
        NetDriver->ServerConnection = nullptr;

        NetLog(Port, "[Networking::Listen] Setting World");

        NetDriver->World = UWorld::GetWorld();

        FURL url = FURL();

        url.Port = Port;

        FString empy = FString();

        NetLog(Port, "[Networking::Listen] Calling Listen...");
        bool ListenStatus = (*(reinterpret_cast<bool(**)(UNetDriver*, void*, FURL*, bool, FString*)>(*(__int64*)NetDriver + 0x290)))(NetDriver, reinterpret_cast<void*>((uintptr_t)UWorld::GetWorld() + 0x28), &url, false, &empy);
        NetLog(Port, std::string("[Networking::Listen] Listen returned ") + (ListenStatus ? "true" : "false"));

        std::string ListenError = empy.ToString();
        if (!ListenError.empty()) {
            NetLog(Port, "[Networking::Listen] Error: " + ListenError);
        }

        if (!ListenStatus) {
            NetLog(Port, "[Networking::Listen] ERROR: InitListen returned false");
            return;
        }

        NetDriver->World = UWorld::GetWorld();
        NetDriver->NetDriverName = GameNetDriver;
        NetDriver->ServerConnection = nullptr;

        NetLog(Port, "[Networking::Listen] Complete");
    }

    void LogReplicationGraphState() {
        if (!RepGraphDiag() || !IsReadablePointer(NetDriver, 0x2B0)) return;
        {
            static uint64_t s_graphDumpMs = 0;
            static int s_lastLiveConns = -2;
            int liveConns = (IsReadablePointer(reinterpret_cast<void*>((uintptr_t)NetDriver + 0x98), 4))
                            ? *reinterpret_cast<int32_t*>((uintptr_t)NetDriver + 0x98) : -1;
            uint64_t gnow = static_cast<uint64_t>(GetTickCount64());
            bool connEdge = (liveConns != s_lastLiveConns);
            if (RepGraphDiag() && (connEdge || (gnow - s_graphDumpMs > 2000))) {
                s_graphDumpMs = gnow;
                s_lastLiveConns = liveConns;
                void* graph = (IsReadablePointer(reinterpret_cast<void*>((uintptr_t)NetDriver + 0x6F0), 8))
                              ? *reinterpret_cast<void**>((uintptr_t)NetDriver + 0x6E8) : nullptr;
                void* ndWorld = (IsReadablePointer(reinterpret_cast<void*>((uintptr_t)NetDriver + 0x148), 8))
                                ? *reinterpret_cast<void**>((uintptr_t)NetDriver + 0x140) : nullptr;

                void* replGate = (IsReadablePointer(reinterpret_cast<void*>((uintptr_t)NetDriver + 0x110), 8))
                                 ? *reinterpret_cast<void**>((uintptr_t)NetDriver + 0x108) : nullptr;
                if (graph && IsReadablePointer(graph, 0xB8)) {
                    void* gClass = *reinterpret_cast<void**>((uintptr_t)graph + 0x10);
                    std::string gcn = (gClass && IsReadablePointer(gClass, 0x20)) ? reinterpret_cast<UObject*>(gClass)->GetName() : "(null)";
                    void* gDriver    = *reinterpret_cast<void**>((uintptr_t)graph + 0x30);
                    void* connMgrCls = *reinterpret_cast<void**>((uintptr_t)graph + 0x28);
                    int globalNodes  = *reinterpret_cast<int*>((uintptr_t)graph + 0xA0);
                    int prepNodes    = *reinterpret_cast<int*>((uintptr_t)graph + 0xB0);
                    int connMgrs     = *reinterpret_cast<int*>((uintptr_t)graph + 0x40);
                    int pendConns    = *reinterpret_cast<int*>((uintptr_t)graph + 0x50);
                    std::string sub = "";
                    if (IsReadablePointer(graph, 0x4C8)) {   
                        void* gridNode = *reinterpret_cast<void**>((uintptr_t)graph + 0x498);
                        void* alwaysRel = *reinterpret_cast<void**>((uintptr_t)graph + 0x4A0);
                        int arfc       = *reinterpret_cast<int*>((uintptr_t)graph + 0x4B0);
                        int actorsNoC  = *reinterpret_cast<int*>((uintptr_t)graph + 0x4C0);
                        sub = " GridNode=" + std::to_string((uintptr_t)gridNode)
                            + " AlwaysRelevantNode=" + std::to_string((uintptr_t)alwaysRel)
                            + " ARFCList=" + std::to_string(arfc)
                            + " ActorsNoConn=" + std::to_string(actorsNoC);
                    }
                    NetLog(LastPort, std::string("[GraphState]") + (connEdge ? " (CONN-EDGE)" : "")
                        + " driver=" + std::to_string((uintptr_t)graph) + " (" + gcn + ")"
                        + " graph.NetDriver=" + std::to_string((uintptr_t)gDriver)
                        + " ConnMgrClass=" + std::to_string((uintptr_t)connMgrCls)
                        + " GlobalGraphNodes=" + std::to_string(globalNodes)
                        + " PrepareNodes=" + std::to_string(prepNodes)
                        + " ConnMgrs=" + std::to_string(connMgrs)
                        + " PendingConns=" + std::to_string(pendConns)
                        + sub
                        + " | NetDriver.World=" + std::to_string((uintptr_t)ndWorld)
                        + " ClientConns=" + std::to_string(liveConns)
                        + " replGate(+0x108)=" + std::to_string((uintptr_t)replGate));

                    if (IsReadablePointer(graph, 0x4C8)) {
                        void** awncData = *reinterpret_cast<void***>((uintptr_t)graph + 0x4B8);
                        int awncNum = *reinterpret_cast<int*>((uintptr_t)graph + 0x4C0);
                        if (awncData && awncNum > 0 && awncNum < 4096) {
                            int cap = awncNum < 8 ? awncNum : 8;
                            for (int i = 0; i < cap; ++i) {
                                if (!IsReadablePointer(reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(awncData) + (size_t)i * 8), 8)) break;
                                AActor* a = reinterpret_cast<AActor*>(awncData[i]);
                                if (!a || !IsReadablePointer(a, 0x420)) continue;
                                std::string acn = a->Class ? a->Class->GetName() : "(null-cls)";
                                std::string afn = a->GetFullName();
                                void* conn = nullptr;
                                std::string chain;
                                AActor* cur = a;
                                for (int d = 0; d < 5 && cur && IsReadablePointer(cur, 0x420); ++d) {
                                    if (cur->IsA(APlayerController::StaticClass())) {
                                        conn = *reinterpret_cast<void**>((uintptr_t)cur + 0x418);
                                        chain += "->PC";
                                        break;
                                    }
                                    AActor* own = *reinterpret_cast<AActor**>((uintptr_t)cur + 0xE0);
                                    chain += (own && IsReadablePointer(own, 0x20) && own->Class) ? ("->" + own->Class->GetName()) : "->(null)";
                                    cur = own;
                                }
                                NetLog(LastPort, "[ActorsNoConn #" + std::to_string(i) + "/" + std::to_string(awncNum) + "] "
                                    + acn + " (" + afn + ") ownerChain=" + chain
                                    + " resolvedConn=" + std::to_string((uintptr_t)conn));
                            }
                        }
                    }
                } else {
                    NetLog(LastPort, std::string("[GraphState]") + (connEdge ? " (CONN-EDGE)" : "")
                        + " ReplicationDriver=" + std::to_string((uintptr_t)graph) + " (null/unreadable)"
                        + " | NetDriver.World=" + std::to_string((uintptr_t)ndWorld)
                        + " ClientConns=" + std::to_string(liveConns));
                }
            }
        }
    }
}
