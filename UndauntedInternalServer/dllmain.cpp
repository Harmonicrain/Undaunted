#include <windows.h>
#include <shellapi.h>
#include <string>
#include <vector>
#include <thread>
#include <iostream>
#include <ranges>
#include <cwchar>
#include <map>
#include <mutex>
#include <atomic>
#include <chrono>

#include "framework.h"
#include "SDK.hpp"
#include "MinHook/MinHook.h"
#include "constants.h"
#include "Networking.h"

#include "SDK/GameplayAbilities_parameters.hpp"
#include "SDK/Archon_parameters.hpp"
#include "SDK/lantern_equipped_ab_parameters.hpp"

using namespace SDK;

namespace Globals {
    static bool AmServer = false;
    static uintptr_t BaseAddress = 0x0;
    bool Listening = false;
    bool DoListen = false;
    const wchar_t* ServerAPIKey = nullptr;
    const wchar_t* MapPath = nullptr;
    const wchar_t* BehemothPath = nullptr;
    const wchar_t* MatchmakerHuntId = nullptr;
    const wchar_t* ExpectedPlayerString = nullptr;
    int Port = 0;
    const wchar_t* MyIpAndPort = nullptr;
    std::wstring MetagameAddress;

    bool EnableLogging = true;
}

std::map<std::wstring, std::wstring> EndpointMap = {};
void EvalEndpointMap() {
    static bool DidEvalEndpointMap = false;

    if (DidEvalEndpointMap || Globals::MetagameAddress.size() == 0)
        return;

    DidEvalEndpointMap = true;

    EndpointMap = {
        {L"AuthEndpoint", L"http://" + Globals::MetagameAddress + L"/game/login"},
        {L"AuthAvailableEndpoint", L"http://" + Globals::MetagameAddress + L"/checkavailable"},
        {L"AuthTagsEndpoint", L"http://" + Globals::MetagameAddress + L"/tags"},
        {L"AccountInfoEndpoint", L"http://" + Globals::MetagameAddress + L"/accountinfo"},
        {L"DauntlessSessionTokenEndpoint", L"http://" + Globals::MetagameAddress + L"/gamesession/{linkedaccountservice}"},
        {L"CreatePhoenixAccountEndpoint", L"http://" + Globals::MetagameAddress + L"/account"},
        {L"LinkAccountEndpoint", L"http://" + Globals::MetagameAddress + L"/account/link"},
        {L"IsAccountLinkedEndpoint", L"http://" + Globals::MetagameAddress + L"/account/link/{service}/{accountid}"},
        {L"LinkPhoenixToServicePinGenerationEndpoint", L"http://" + Globals::MetagameAddress + L"/account/link/pin/{service}/generate"},
        {L"LinkPhoenixToServicePinStatusEndpoint", L"http://" + Globals::MetagameAddress + L"/account/link/pin/{service}/status"},
        {L"QueryLoginQueueEndpoint", L"http://" + Globals::MetagameAddress + L"/login"},
        {L"PublicAccountInfoEndpoint", L"http://" + Globals::MetagameAddress + L"/accountinfo/public"},
        {L"QueryAccountMappingsEndpoint", L"http://" + Globals::MetagameAddress + L"/account/mapping"},
        {L"PlayerDataMigrationEndpoint", L"http://" + Globals::MetagameAddress + L"/account/migrate"},
        {L"PhoenixEventsEndpoint", L"http://" + Globals::MetagameAddress + L"/event?id={environment}"},
        {L"PhoenixEventsMessageEndpoint", L"http://" + Globals::MetagameAddress + L"/services/T02H74TGF/B8GG4RATX/EGSR335K7as3GFBq4dPCm7js"},
        {L"CharacterEndpoint", L"http://" + Globals::MetagameAddress + L"/character"},
        {L"FindCharacterEndpoint", L"http://" + Globals::MetagameAddress + L"/character/{characterid}"},
        {L"CharacterNameEndpoint", L"http://" + Globals::MetagameAddress + L"/character/name"},
        {L"FindCharactersEndpoint", L"http://" + Globals::MetagameAddress + L"/character/batch/account"},
        {L"ResetCharacterEndpoint", L"http://" + Globals::MetagameAddress + L"/character"},
        {L"InventoryEndpoint", L"http://" + Globals::MetagameAddress + L"/inventory"},
        {L"InventoryGetAllEndpoint", L"http://" + Globals::MetagameAddress + L"/inventory/{accountid}/{characterid}"},
        {L"InventoryGetInstanceItemsEndpoint", L"http://" + Globals::MetagameAddress + L"/inventory/instanceditemsbyaccount"},
        {L"InventoryUpdateInstanceEndpoint", L"http://" + Globals::MetagameAddress + L"/inventory/instanceditem"},
        {L"InventoryMigrateEndpoint", L"http://" + Globals::MetagameAddress + L"/inventory/{characterid}/{gameversion}"},
        {L"DeleteProgressionEndpoint", L"http://" + Globals::MetagameAddress + L"/progression/{accountid}/{progressionid}"},
        {L"ProgressionEndpoint", L"http://" + Globals::MetagameAddress + L"/progression"},
        {L"ProgressionConfigEndpoint", L"http://" + Globals::MetagameAddress + L"/progression/config"},
        {L"FindProgressionEndpoint", L"http://" + Globals::MetagameAddress + L"/progression/{accountid}"},
        {L"FindProgressionTrackEndpoint", L"http://" + Globals::MetagameAddress + L"/progression/{accountid}/{progressionid}"},
        {L"FindObjectiveEndpoint", L"http://" + Globals::MetagameAddress + L"/progression/objectives/{accountid}/{objectiveid}"},
        {L"FindObjectivesEndpoint", L"http://" + Globals::MetagameAddress + L"/progression/objectives/{accountid}"},
        {L"GrantProgressionWithObjectives", L"http://" + Globals::MetagameAddress + L"/progression/{accountid}"},
        {L"GrantProgressionEndpoint", L"http://" + Globals::MetagameAddress + L"/progression/{accountid}/{progressionid}/{amount}"},
        {L"ConfirmProgressionEndpoint", L"http://" + Globals::MetagameAddress + L"/progression/{accountid}/{progressionid}/{rank}/confirm/{kind}"},
        {L"GetBountiesConfigEndpoint", L"http://" + Globals::MetagameAddress + L"/bounty/game-data"},
        {L"GetBountiesEndpoint", L"http://" + Globals::MetagameAddress + L"/bounty/{accountid}"},
        {L"SetBountiesEndpoint", L"http://" + Globals::MetagameAddress + L"/bounty/{accountid}"},
        {L"GetPlayerJourneyEndpointServer", L"http://" + Globals::MetagameAddress + L"/pjm/{accountid}"},
        {L"GetPlayerJourneyEndpointClient", L"http://" + Globals::MetagameAddress + L"/pjm"},
        {L"SetPlayerJourneyEndpoint", L"http://" + Globals::MetagameAddress + L"/pjm/{accountid}"},
        {L"DeleteBountiesEndpoint", L"http://" + Globals::MetagameAddress + L"/bounty/delete/{accountid}"},
        {L"GetCooldownEndpoint", L"http://" + Globals::MetagameAddress + L"/cooldown/{accountid}"},
        {L"StartCooldownEndpoint", L"http://" + Globals::MetagameAddress + L"/cooldown/{accountid}/{cooldownid}"},
        {L"SetCooldownEndpoint", L"http://" + Globals::MetagameAddress + L"/cooldown/{accountid}"},
        {L"SetCooldownBatchEndpoint", L"http://" + Globals::MetagameAddress + L"/cooldown/batch/{accountid}"},
        {L"GetSeasonalEscalationEndpoint", L"http://" + Globals::MetagameAddress + L"/escalation/{season_id}/{account_id}"},
        {L"UpdateSeasonalEscalationEndpoint", L"http://" + Globals::MetagameAddress + L"/escalation/{season_id}/{account_id}"},
        {L"GameTuningEndpoint", L"http://" + Globals::MetagameAddress + L"/game_tuning/{blobid}"},
        {L"SelectedHuntPassEndpoint", L"http://" + Globals::MetagameAddress + L"/huntpass/{accountid}"},
        {L"TitleNewsEndpoint", L"http://" + Globals::MetagameAddress + L"/patcher-news/{environment}.json"},
        {L"LoginNewsEndpoint", L"http://" + Globals::MetagameAddress + L"/motd/"},
        {L"AfterHuntNewsEndpoint", L"http://" + Globals::MetagameAddress + L"/motd/trigger?event_name={eventname}"},
        {L"MailboxQueryEndpoint", L"http://" + Globals::MetagameAddress + L"/all/"},
        {L"MailboxQuerySurveyEndpoint", L"http://" + Globals::MetagameAddress + L"/survey/{surveyid}"},
        {L"MessageInboxReadEndpoint", L"http://" + Globals::MetagameAddress + L"/mailbox/markAsRead"},
        {L"MessageInboxDeletedEndpoint", L"http://" + Globals::MetagameAddress + L"/mailbox/markAsDeleted"},
        {L"MessageInboxClaimItemEndpoint", L"http://" + Globals::MetagameAddress + L"/mailbox/redeemParcel"},
        {L"MailboxSubmitSurveyEndpoint", L"http://" + Globals::MetagameAddress + L"/survey/responses"},
        {L"MailboxClaimSurveyRewardEndpoint", L"http://" + Globals::MetagameAddress + L"/survey/redeemReward"},
        {L"MailboxSurveyEndpoint", L"http://" + Globals::MetagameAddress + L"/survey"},
        {L"ExperimentalRealmValidationEndpoint", L"http://" + Globals::MetagameAddress + L"/experiment/validate"},
        {L"SanitizeEndpoint", L"http://" + Globals::MetagameAddress + L"/check"},
        {L"GuildEndpoint", L"http://" + Globals::MetagameAddress + L"/guild"},
        {L"GuildInvitesEndpoint", L"http://" + Globals::MetagameAddress + L"/guild/invites"},
        {L"FindGuildEndpoint", L"http://" + Globals::MetagameAddress + L"/guild/{guildid}"},
        {L"FindCharactersGuildEndpoint", L"http://" + Globals::MetagameAddress + L"/guild/member/{characterid}"},
        {L"GuildMemberEndpoint", L"http://" + Globals::MetagameAddress + L"/guild/member"},
        {L"GuildInviteEndpoint", L"http://" + Globals::MetagameAddress + L"/guild/invite"},
        {L"GuildViewCharacterInviteEndpoint", L"http://" + Globals::MetagameAddress + L"/guild/invite/member/{characterid}"},
        {L"GuildAcceptInviteEndpoint", L"http://" + Globals::MetagameAddress + L"/guild/invite/accept"},
        {L"GuildViewGuildInviteEndpoint", L"http://" + Globals::MetagameAddress + L"/guild/invite/guild"},
        {L"GuildLeaderEndpoint", L"http://" + Globals::MetagameAddress + L"/guild/leader"},
        {L"GuildCreateValidateEndpoint_v2", L"http://" + Globals::MetagameAddress + L"/guild/validate"},
        {L"GuildEndpoint_v2", L"http://" + Globals::MetagameAddress + L"/guild"},
        {L"GuildDisbandEndpoint_v2", L"http://" + Globals::MetagameAddress + L"/guild/{guildId}"},
        {L"GuildViewInvitesEndpoint_v2", L"http://" + Globals::MetagameAddress + L"/guild/invite/player"},
        {L"GuildInviteEndpoint_v2", L"http://" + Globals::MetagameAddress + L"/guild/invite/{accountId}"},
        {L"GuildInviteAcceptEndpoint_v2", L"http://" + Globals::MetagameAddress + L"/guild/invite/accept/{guild_invite_id}"},
        {L"GuildInviteDeclineEndpoint_v2", L"http://" + Globals::MetagameAddress + L"/guild/invite/{guild_invite_id}"},
        {L"GuildLeaveEndpoint_v2", L"http://" + Globals::MetagameAddress + L"/guild/player"},
        {L"GuildKickEndpoint_v2", L"http://" + Globals::MetagameAddress + L"/guild/player/{accountId}"},
        {L"GuildChangeRankEndpoint_v2", L"http://" + Globals::MetagameAddress + L"/guild/rank/{accountId}/{rank}"},
        {L"PartyEndpoint", L"http://" + Globals::MetagameAddress + L"/party"},
        {L"PartyStatusEndpoint", L"http://" + Globals::MetagameAddress + L"/party/status"},
        {L"PartyMemberEndpoint", L"http://" + Globals::MetagameAddress + L"/party/member"},
        {L"PartyKickMemberEndpoint", L"http://" + Globals::MetagameAddress + L"/party/member/{memberid}"},
        {L"PartyRemoveOfflineLeaderEndpoint", L"http://" + Globals::MetagameAddress + L"/party/leader/{leaderid}"},
        {L"PartyPromoteEndpoint", L"http://" + Globals::MetagameAddress + L"/party/member/promote/{memberId}"},
        {L"PartyInvitesEndpoint", L"http://" + Globals::MetagameAddress + L"/party/invites"},
        {L"PartyInviteEndpoint", L"http://" + Globals::MetagameAddress + L"/party/invite"},
        {L"PartyAcceptInviteEndpoint", L"http://" + Globals::MetagameAddress + L"/party/invite/accept/{inviteId}"},
        {L"PartyMemberSetConsoleSessionEndpoint", L"http://" + Globals::MetagameAddress + L"/party/console_session"},
        {L"PartyFinderCreateEndpoint", L"http://" + Globals::MetagameAddress + L"/party/finder/entry/create"},
        {L"PartyFinderEntryEndpoint", L"http://" + Globals::MetagameAddress + L"/party/finder/entry/{partyId}"},
        {L"PartyFinderJoinEndpoint", L"http://" + Globals::MetagameAddress + L"/party/finder/join/{partyId}"},
        {L"PartyFinderListEntriesEndpoint", L"http://" + Globals::MetagameAddress + L"/party/finder/entries"},
        {L"ExpectedPlayerStatusEndpoint", L"http://" + Globals::MetagameAddress + L"/candidate/player/alive"},
        {L"KeepAlivePlayerStatusEndpoint", L"http://" + Globals::MetagameAddress + L"/candidate/player/alive"},
        {L"StoreEndpointDev", L"http://" + Globals::MetagameAddress + L"/{tracking}#{path}"},
        {L"StoreEndpoint", L"http://" + Globals::MetagameAddress + L"/{tracking}#{path}"},
        {L"StoreInternationalEndpointDev", L"http://" + Globals::MetagameAddress + L"/{locale}/{tracking}#{path}"},
        {L"StoreInternationalEndpoint", L"http://" + Globals::MetagameAddress + L"/{locale}/{tracking}#{path}"},
        {L"StoreGetItemByTagEndpoint", L"http://" + Globals::MetagameAddress + L"/product/skus/public?requiredTags={tag}"},
        {L"StoreGetItemByIdEndpoint", L"http://" + Globals::MetagameAddress + L"/product/sku/{sku_id}"},
        {L"StorePurchaseItemEndpoint", L"http://" + Globals::MetagameAddress + L"/token/{currency}/{sku_id}"},
        {L"StorePurchaseItemConfirmEndpoint", L"http://" + Globals::MetagameAddress + L"/notification/{currency}?token={purchase_token}"},
        {L"StoreReconcileUrl", L"http://" + Globals::MetagameAddress + L"/reconcile"},
        {L"StoreBalancesEndpoint", L"http://" + Globals::MetagameAddress + L"/balance"},
        {L"SupportACreatorEndpoint", L"http://" + Globals::MetagameAddress + L"/creator"},
        {L"EntitlementsEndpoint", L"http://" + Globals::MetagameAddress + L"/entitlementsv2"},
        {L"GrantEntitlementEndpoint", L"http://" + Globals::MetagameAddress + L"/entitlementv2/{accountid}"},
        {L"RevokeEntitlementEndpoint", L"http://" + Globals::MetagameAddress + L"/entitlement/{accountid}/{entitlement}"},
        {L"ServiceSessionEndpoint", L"http://" + Globals::MetagameAddress + L"/ws/{accountid}"},
        {L"QueryUserPresenceEndpoint", L"http://" + Globals::MetagameAddress + L"/present/{accountid}"},
        {L"MatchmakingEndpoint", L"http://" + Globals::MetagameAddress},
        {L"TrackingEndpoint", L"http://" + Globals::MetagameAddress},
        {L"VoiceChatLoginEndpoint", L"http://" + Globals::MetagameAddress + L"/vivox/login"},
        {L"VoiceChatJoinPartyEndpoint", L"http://" + Globals::MetagameAddress + L"/vivox/join/party/{channel_type}"},
        {L"VoiceChatJoinGameEndpoint", L"http://" + Globals::MetagameAddress + L"/vivox/join/game/{game_id}/{channel_type}"},
        {L"VoiceChatJoinDebugEndpoint", L"http://" + Globals::MetagameAddress + L"/vivox/join/channel/{channel_id}/{channel_type}"},
        {L"PlatformPoolRegistrationEndpoint", L"http://" + Globals::MetagameAddress + L"/candidate/player/register"},
        {L"CheckCrossPlayProgressionEndpoint", L"http://" + Globals::MetagameAddress + L"/features/platform/{platform}"},
        {L"LeaderboardDisplayNameRefreshEndpoint", L"http://" + Globals::MetagameAddress + L"/profile/update"},
        {L"PhoenixStatusMessageEndpoint", L"http://" + Globals::MetagameAddress + L"/dauntless-status"},
        {L"TrialsLeaderboardsEndpoint", L"http://" + Globals::MetagameAddress + L"/trials/leaderboards"},
        {L"TrialsSoloLeaderboardsEndpoint", L"http://" + Globals::MetagameAddress + L"/trials/leaderboards/solo"},
        {L"TrialsSoloEntryEndpoint", L"http://" + Globals::MetagameAddress + L"/trials/leaderboards/solo/individual"},
        {L"TrialsGroupLeaderboardsEndpoint", L"http://" + Globals::MetagameAddress + L"/trials/leaderboards/group"},
        {L"TrialsGroupEntryEndpoint", L"http://" + Globals::MetagameAddress + L"/trials/leaderboards/group/individual"},
        {L"GetActiveLoadoutEndpoint", L"http://" + Globals::MetagameAddress + L"/loadout/{account_id}/{character_id}"},
        {L"GetAllLoadoutsEndpoint", L"http://" + Globals::MetagameAddress + L"/loadout/{account_id}/{character_id}/all"},
        {L"UpdateLoadoutSlotEndpoint", L"http://" + Globals::MetagameAddress + L"/loadout/{account_id}/{character_id}/{index}"},
        {L"UpdateLoadoutSlotSetActiveEndpoint", L"http://" + Globals::MetagameAddress + L"/loadout/{account_id}/{character_id}/active/{index}"},
        {L"UpdateLoadoutPersistentEndpoint", L"http://" + Globals::MetagameAddress + L"/loadout/{account_id}/{character_id}/persistent"},
        {L"UpdateActiveLoadoutSlotEndpoint", L"http://" + Globals::MetagameAddress + L"/loadout/{account_id}/{character_id}/active/{index}"},
        {L"UnlockAccountSlotEndpoint", L"http://" + Globals::MetagameAddress + L"/loadout/{account_id}/unlock/{num_slots}"},
        {L"UnlockCharacterSlotEndpoint", L"http://" + Globals::MetagameAddress + L"/loadout/{account_id}/{character_id}/unlock/{num_slots}"},
        {L"GetAccountSlotCountEndpoint", L"http://" + Globals::MetagameAddress + L"/loadout/{account_id}/slotcount"},
        {L"GetCharacterSlotCountEndpoint", L"http://" + Globals::MetagameAddress + L"/loadout/{account_id}/{character_id}/slotcount"},
        {L"PlayerInboxMessageEndpoint", L"http://" + Globals::MetagameAddress + L"/subscription"},
        {L"PlayerNewsletterSubscribeEndpoint", L"http://" + Globals::MetagameAddress + L"/subscription"},
        {L"PlayerNewsletterResendEndpoint", L"http://" + Globals::MetagameAddress + L"/subscription/verify/resend"},
        {L"BreadcrumbPlayerEndpoint", L"http://" + Globals::MetagameAddress + L"/breadcrumbs/{character_id}"},
        {L"EncounteredContentGetEndpoint", L"http://" + Globals::MetagameAddress + L"/encountered-content/{character_id}/{content_type}"},
        {L"EncounteredContentQueryEndpoint", L"http://" + Globals::MetagameAddress + L"/encountered-content/query/{character_id}"},
        {L"EncounteredContentUpdateEndpoint", L"http://" + Globals::MetagameAddress + L"/encountered-content/{character_id}"},
        {L"CohortsEndpoint", L"http://" + Globals::MetagameAddress + L"/playertreatments/{account_id}"},
        {L"GetEventStatsEndpoint", L"http://" + Globals::MetagameAddress + L"/eventstats/"},
        {L"IncrementEventStatsEndpoint", L"http://" + Globals::MetagameAddress + L"/eventstats/increment"},
        {L"LinkedSlayersInviteEndpoint", L"http://" + Globals::MetagameAddress + L"/slayerlink/invite"},
        {L"LinkedSlayersAllInvitesEndpoint", L"http://" + Globals::MetagameAddress + L"/slayerlink/invites"},
        {L"LinkedSlayersInviteAcceptDeclineEndpoint", L"http://" + Globals::MetagameAddress + L"/slayerlink/invite"},
        {L"LinkedSlayersInviteCancelEndpoint", L"http://" + Globals::MetagameAddress + L"/slayerlink/invite"},
        {L"LinkedSlayersDeleteAllInvitesEndpoint", L"http://" + Globals::MetagameAddress + L"/slayerlink/invites/{account_id}"},
        {L"LinkedSlayersAllLinksProgressEndpoint", L"http://" + Globals::MetagameAddress + L"/slayerlink/progress"},
        {L"LinkedSlayersAddLinkProgressEndpoint", L"http://" + Globals::MetagameAddress + L"/slayerlink/progress"},
        {L"LinkedSlayersAllLinkSlotsDataEndpoint", L"http://" + Globals::MetagameAddress + L"/slayerlink/links"},
        {L"LinkedSlayersDeleteInviteDataEndpoint", L"http://" + Globals::MetagameAddress + L"/slayerlink/link"},
        {L"LinkedSlayersSendRewardsEndpoint", L"http://" + Globals::MetagameAddress + L"/slayerlink/links/rewards"},
        {L"LinkedSlayersGetFriendsAvailabilityEndpoint", L"http://" + Globals::MetagameAddress + L"/slayerlink/availability"},
        {L"LinkedSlayersGetRewardsGrantEndpoint", L"http://" + Globals::MetagameAddress + L"/slayerlink/links/rewards/{account_id}/{slot}"},
        {L"LinkedSlayersSetEndTimeEndpoint", L"http://" + Globals::MetagameAddress + L"/slayerlink/links/endtime"},
        {L"LinkedSlayersSetRemainingTimeEndpoint", L"http://" + Globals::MetagameAddress + L"/slayerlink/links/timeleft"},
        {L"LinkedSlayersStatusEndpoint", L"http://" + Globals::MetagameAddress + L"/slayerlink/status_good"},
        {L"AccountCheckpointDebugEndpoint", L"http://" + Globals::MetagameAddress + L"/checkpoint/account/save"},
    };
}


__declspec(dllexport) const char* DummyLinkFunc() {
    return "mrow :3";
}

void MainThread() {
    while (!UWorld::GetWorld()) {
        if (Globals::AmServer) {
            Sleep(1000);
        }
        else {
            Sleep(1);
        }
    }

    Sleep(3 * 1000);

    if (!Globals::AmServer) {
        UEngine* Engine = UEngine::GetEngine();

        UInputSettings::GetDefaultObj()->ConsoleKeys[0].KeyName = UKismetStringLibrary::Conv_StringToName(L"F2");

        UObject* NewObject = UGameplayStatics::SpawnObject(Engine->ConsoleClass, Engine->GameViewport);

        Engine->GameViewport->ViewportConsole = static_cast<UConsole*>(NewObject);

        if (Globals::EnableLogging)
        std::cout << "Spawned UConsole!" << std::endl;
    }
    else {
        if (Globals::EnableLogging)
        std::cout << "UWorld is live!" << std::endl;

        Globals::DoListen = true;
    }
}

void* OrigGetDefaultMap = nullptr;

FString* GetGameDefaultMap(FString* a1) {
    FString* Ret = reinterpret_cast<FString*(*)(FString*)>(OrigGetDefaultMap)(a1);

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

    *Ret = FinalURL.c_str();

    //*Ret = L"ramsgate_01_persistent?game=/Game/Blueprints/BPGM_Archon_Prototype.BPGM_Archon_Prototype_C?MonsterClass=/Game/Monsters/mcrollin/mcbeaver_tutorial_bp.mcbeaver_tutorial_bp_C";

    //*Ret = L"/Game/Maps/islands/1705/dia_moss_triforce?MonsterClass=/Game/Monsters/mcrollin/mcbeaver_tutorial_bp.mcbeaver_tutorial_bp_C";
    //*Ret = L"/Game/Maps/islands/1705/dia_snow_big?MonsterClass=/Game/Monsters/mcrollin/mcbeaver_tutorial_bp.mcbeaver_tutorial_bp_C?HuntId=CR19_MatchmakerHunt_Beaver?PlayerHuntIds=GWOG-UID-1:CR19_PlayerHunt_Expedition_Island04,GWOG-UID-2:CR19_PlayerHunt_Expedition_Island04,GWOG-UID-3:CR19_PlayerHunt_Expedition_Island04?ZonePreset=0";
    //*Ret = L"/Game/Maps/ramsgate/ramsgate_01_persistent";
    //*Ret = L"/Game/Maps/islands/dojo/training_dojo_persistent";
    //*Ret = L"/Game/Maps/islands/1705/dia_moss_triforce?MonsterClass=/Game/Monsters/mcrollin/mcbeaver_tutorial_bp.mcbeaver_tutorial_bp_C";

    return Ret;
}

void* OrigGetCommandLine = nullptr;

const wchar_t* GetCommandLineHook() {
    return L"Dauntless-Win64-Shipping.exe -server -unattended -nullrhi -nosound -EpicPortal -RepDriverDisable";
}

void* OrigServerBootCrash = nullptr;

void ServerBootCrash() {
    return;
}

void* OrigEncounterableSetup = nullptr;

void EncounterableSetupHook() {
    return;
}

float TotalNoPlayersTime = 0.0f;

// Character ids of the players connected to this world, refreshed on the game
// thread and attached to every metagame request (see ProcessRequest). The
// metagame uses it to tell whether Hunt Pass XP was earned while hunting with
// a linked partner; the gameserver is the only party that knows who is
// actually in the instance.
std::mutex CopresentMutex;
std::wstring CopresentCharacterIds;
float CopresentRefreshTime = 0.0f;

void RefreshCopresentPlayers(float DeltaTime) {
    CopresentRefreshTime += DeltaTime;
    if (CopresentRefreshTime < 1.0f)
        return;
    CopresentRefreshTime = 0.0f;

    std::wstring Ids;
    for (UNetConnection* Conn : Networking::NetDriver->ClientConnections) {
        if (!Conn || !Conn->PlayerController || *(uint32_t*)((uintptr_t)Conn + 0x134) != 3)
            continue;
        if (!Conn->PlayerController->IsA(AArchonPlayerControllerBase::StaticClass()))
            continue;

        std::wstring Id = static_cast<AArchonPlayerControllerBase*>(Conn->PlayerController)->CharacterId.ToWString();
        if (Id.empty() || Id.find(L',') != std::wstring::npos)
            continue;
        if (!Ids.empty())
            Ids += L',';
        Ids += Id;
    }

    std::lock_guard<std::mutex> Lock(CopresentMutex);
    CopresentCharacterIds = Ids;
}

bool EnableWatchdog = true;

void* OrigGameEngineTick = nullptr;

void GameEngineTickHook(UGameEngine* GameEngine, float DeltaTime, char CanRender) {
    reinterpret_cast<void(*)(UGameEngine*, float, char)>(OrigGameEngineTick)(GameEngine, DeltaTime, CanRender);

    if (Globals::Listening) {
        Networking::TickNetworking();
    }

    if (Globals::DoListen) {
        Globals::DoListen = false;
        Networking::Listen(UEngine::GetEngine(), Globals::Port);

        Globals::Listening = true;
    }

    if (Globals::Listening && Networking::NetDriver) {
        bool HasConnection = false;

        for (UNetConnection* Connection : Networking::NetDriver->ClientConnections) {
            if (!Connection->OwningActor || *(uint32_t*)((uintptr_t)Connection + 0x134) != 3)
                continue;

            HasConnection = true;
        }

        if (EnableWatchdog) {
            if (!HasConnection) {
                TotalNoPlayersTime += DeltaTime;

                if (TotalNoPlayersTime >= 50.0f) {
                    exit(0);
                }
            }
        }

        RefreshCopresentPlayers(DeltaTime);

        for (UNetConnection* Conn : Networking::NetDriver->ClientConnections) {
            if (Conn->PlayerController && Conn->PlayerController->Pawn) {
                ((ABP_PlayerCharacter_C*)Conn->PlayerController->Pawn)->TickStamina(ECityExecFilter::Both, ERemoteExecFilter::All); // TODO: Risky cast, but IsA brutalizes our speed
            }
        }
    }
}

void* OrigFixupNetworkNotify = nullptr;

void* FixupNetworkNotifyHook(void* a1) {
    if(UWorld::GetWorld())
        *(void**)((uintptr_t)a1 + 0x208) = &UWorld::GetWorld()->NetworkNotify;

    return reinterpret_cast<void* (*)(void*)>(OrigFixupNetworkNotify)(a1);
}

void* OrigProcessRequest = nullptr;

// Every metagame request from this gameserver carries a stable id, so the
// metagame can recognise a request it has already applied. The id is stored
// in the request's own header map (TMap<FString, FString> at +0xC0, the map
// SetHeader at +0x28AAAA0 adds to), so reprocessing the same request object
// reuses it while every new request gets a fresh one.
std::atomic<uint64_t> RequestCounter{ 0 };
const uint64_t ProcessStartMs = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
    std::chrono::system_clock::now().time_since_epoch()).count());

// Raw read of the UE4 TSet layout behind that TMap: element array {data, num,
// max}, allocation bit array (four inline words, secondary pointer, NumBits),
// then free list and hash. Each element is TPair<FString, FString> plus two
// int32 (40 bytes). Bounds-checked and SEH-guarded with no C++ objects in
// scope, so an unexpected layout reads as "absent" instead of faulting.
static bool HasRequestHeader(const uint8_t* Map, const wchar_t* Name) {
    __try {
        const uint8_t* Elements = *(const uint8_t* const*)(Map + 0x00);
        const int32_t Num = *(const int32_t*)(Map + 0x08);
        const uint32_t* Secondary = *(const uint32_t* const*)(Map + 0x20);
        const int32_t NumBits = *(const int32_t*)(Map + 0x28);
        if (Num < 0 || Num > 256 || NumBits < Num || (Num > 0 && !Elements))
            return false;
        const uint32_t* Bits = Secondary ? Secondary : (const uint32_t*)(Map + 0x10);
        for (int32_t Index = 0; Index < Num; Index++) {
            if (!(Bits[Index / 32] & (1u << (Index % 32))))
                continue;
            const uint8_t* Element = Elements + (size_t)Index * 40;
            const wchar_t* Key = *(const wchar_t* const*)Element;
            const int32_t KeyNum = *(const int32_t*)(Element + 8);
            if (Key && KeyNum > 0 && KeyNum < 256 && _wcsicmp(Key, Name) == 0)
                return true;
        }
        return false;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

static void StampRequestIdentity(void* Request) {
    if (!HasRequestHeader(reinterpret_cast<const uint8_t*>(Request) + 0xC0, L"x-undaunted-request-id")) {
        std::wstring Id = std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(ProcessStartMs) + L"-" + std::to_wstring(++RequestCounter);
        FString IdHeader(L"x-undaunted-request-id");
        FString IdValue(Id.c_str());
        reinterpret_cast<void(*)(void*, FString*, FString*)>(Globals::BaseAddress + 0x28AAAA0)(Request, &IdHeader, &IdValue);
    }
}

char ClientProcessRequest(void* Request) {
    StampRequestIdentity(Request);
    return reinterpret_cast<char(*)(void*)>(OrigProcessRequest)(Request);
}

char ProcessRequest(void* Request) {
    FString APIHeader(L"x-undaunted-gameserver-apikey");
    FString APIKey(Globals::ServerAPIKey);

    reinterpret_cast<void(*)(void*, FString*, FString*)>(Globals::BaseAddress + 0x28AAAA0)(Request, &APIHeader, &APIKey);

    std::wstring Copresent;
    {
        std::lock_guard<std::mutex> Lock(CopresentMutex);
        Copresent = CopresentCharacterIds;
    }

    StampRequestIdentity(Request);

    FString WorldHeader(L"x-undaunted-world");
    FString WorldValue(Globals::MapPath ? Globals::MapPath : L"");
    reinterpret_cast<void(*)(void*, FString*, FString*)>(Globals::BaseAddress + 0x28AAAA0)(Request, &WorldHeader, &WorldValue);

    FString CopresentHeader(L"x-undaunted-copresent");
    FString CopresentValue(Copresent.c_str());
    reinterpret_cast<void(*)(void*, FString*, FString*)>(Globals::BaseAddress + 0x28AAAA0)(Request, &CopresentHeader, &CopresentValue);

    return reinterpret_cast<char(*)(void*)>(OrigProcessRequest)(Request);
}

enum EFunctionCallspace : uint32_t
{
    /** This function call should be absorbed (ie client side with no authority) */
    Absorbed = 0x0,
    /** This function call should be called remotely via its net driver */
    Remote = 0x1,
    /** This function call should be called locally */
    Local = 0x2
};

void* OrigGetActorCallspace = nullptr;

EFunctionCallspace GetActorCallspace(AActor* Actor, UFunction* Function, void* Stack) {
    if (Function->GetFullName().contains("Ammo")) {
        std::cout << Actor->GetFullName() << " - " << Function->GetFullName() << std::endl;
    }

    return reinterpret_cast<EFunctionCallspace(*)(AActor*, UFunction*, void*)>(OrigGetActorCallspace)(Actor, Function, Stack);
}

void* OrigPostLogin = nullptr;

void PostLoginHook(void* a1, AArchonPlayerController* a2) {
    reinterpret_cast<void(*)(void*, void*)>(OrigPostLogin)(a1, a2);
}

void* OrigHasFinishedLoading = nullptr;

bool HasFinishedLoadingHook(UObject* a1) {
    bool Ret = reinterpret_cast<bool(*)(UObject*)>(OrigHasFinishedLoading)(a1);

    if (!Ret) {
        if (Globals::EnableLogging)
        std::cout << "[FORCEREADY] " << a1->GetFullName() << std::endl;
        return true;
    }

    return Ret;
}

void* OrigIsNetReady = nullptr;

bool IsNetReadyHook() {
    return true;
}

void* OrigSetReplicationDriver = nullptr;

void SetReplicationDriverHook(UNetDriver* NetDriver, UReplicationDriver* RepDriver) {
    return reinterpret_cast<void(*)(UNetDriver*, UReplicationDriver*)>(OrigSetReplicationDriver)(NetDriver, nullptr);
}

void* OrigGetNetDriverInternal = nullptr;

UNetDriver* GetNetDriverInternalHook(void* a1, void* a2) {
    UNetDriver* NetDriver = reinterpret_cast<UNetDriver* (*)(void*, void*)>(OrigGetNetDriverInternal)(a1, a2);

    if (!NetDriver) {
        NetDriver = Networking::NetDriver;
    }

    return NetDriver;
}

void* OrigIsLevelInitForActor = nullptr;

bool IsLevelInitForActorHook(void* a1, char a2) {
    bool NetDriver = reinterpret_cast<bool (*)(void*, char)>(OrigIsLevelInitForActor)(a1, a2);

    if (!NetDriver) {
        return true;
    }

    return NetDriver;
}

void* OrigGetStartSpot = nullptr;

APlayerStart* GetStartSpotHook(void* a1, void* a2, void* a3) {
    for (int i = 0; i < SDK::UObject::GObjects->Num(); i++)
    {
        SDK::UObject* Obj = SDK::UObject::GObjects->GetByIndex(i);

        if (!Obj)
            continue;

        if (Obj->IsDefaultObject())
            continue;

        if (Obj->IsA(SDK::APlayerStart::StaticClass()))
        {
            return (APlayerStart*)Obj;
        }
    }

    if (Globals::EnableLogging)
    std::cout << "No startspot found!" << std::endl;

    return nullptr;
}

bool ServerTryActivateAbilityInternal(UAbilitySystemComponent* Component, FGameplayAbilitySpecHandle& AbilityHandle, bool InputPressed, FPredictionKey& PredictionKey, FGameplayEventData* TriggerEventData) {
    if(InputPressed)
        Component->ServerSetInputPressed(AbilityHandle);

    void* InstancedAbility = nullptr;

    bool Activated = reinterpret_cast<bool(*)(UAbilitySystemComponent*, uint32_t, FPredictionKey*, void**, void*, FGameplayEventData*)>(Globals::BaseAddress + 0x10C8C80)(Component, AbilityHandle.Handle, &PredictionKey, &InstancedAbility, nullptr, TriggerEventData);

    if (!Activated && InputPressed)
        Component->ServerSetInputReleased(AbilityHandle);

    return Activated;
}

void* OrigMakeDoDamage = nullptr;

bool MakeDoDamageHook(void* a1, void* a2, void* a3) {
    *(uint8_t*)((uintptr_t)a1 + 0x57C) = 1;

    return true;
}

#include <fstream>

void* OrigProcessEventClient = nullptr;

void ProcessEventClientHook(UObject* Object, UFunction* Function, void* Parms) {
    if (GetAsyncKeyState(VK_F7)) {
        for (int i = 0; i < SDK::UObject::GObjects->Num(); i++)
        {
            SDK::UObject* Obj = SDK::UObject::GObjects->GetByIndex(i);

            if (!Obj)
                continue;

            if (Obj->IsA(SDK::UArenaMapHuntsFeature::StaticClass()))
            {
                UArenaMapHuntsFeature* Quest = (UArenaMapHuntsFeature*)Obj;

                std::cout << Quest->bEnabled << std::endl;
            }
        }

        while (GetAsyncKeyState(VK_F7)) {

        }
    }

    reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEventClient)(Object, Function, Parms);
}

static int NumTimesOnAirshipUpdated = 0;
bool DidDoTravelReset = false;

void* OrigProcessEvent = nullptr;

void ProcessEventHook(UObject* Object, UFunction* Function, void* Parms) {
    static UFunction* ServerTryActivateAbilityWithEventData = nullptr;
    static UFunction* ServerTryActivateAbility = nullptr;

    if (Function == ServerTryActivateAbilityWithEventData || (!ServerTryActivateAbilityWithEventData && Function->GetFullName().contains("ServerTryActivateAbilityWithEventData"))) {
        ServerTryActivateAbilityWithEventData = Function;

        Params::AbilitySystemComponent_ServerTryActivateAbilityWithEventData* ActivateAbilityParams = (Params::AbilitySystemComponent_ServerTryActivateAbilityWithEventData*)Parms;

        ServerTryActivateAbilityInternal((UAbilitySystemComponent*)Object, ActivateAbilityParams->AbilityToActivate, ActivateAbilityParams->InputPressed, ActivateAbilityParams->PredictionKey, &ActivateAbilityParams->TriggerEventData);
    }
    else if (Function == ServerTryActivateAbility || (!ServerTryActivateAbility && Function->GetFullName().contains("ServerTryActivateAbility"))) {
        ServerTryActivateAbility = Function;

        Params::AbilitySystemComponent_ServerTryActivateAbility* ActivateAbilityParams = (Params::AbilitySystemComponent_ServerTryActivateAbility*)Parms;

        ServerTryActivateAbilityInternal((UAbilitySystemComponent*)Object, ActivateAbilityParams->AbilityToActivate, ActivateAbilityParams->InputPressed, ActivateAbilityParams->PredictionKey, nullptr);
    }

    reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEvent)(Object, Function, Parms);
}

void* OrigConfigCacheIniGetString = nullptr;

bool ConfigCacheInitGetStringHook(void* a1, const wchar_t* Section, const wchar_t* Key, FString* Value, FString* Filename) {
    EvalEndpointMap();

    if (EndpointMap.contains(Key)) {
        *Value = FString(EndpointMap.at(Key).c_str());

        return true;
    }

    // XMPP (friends presence, party and chat rooms). The generic rule below
    // would turn Domain into "host:60000", which the client rejects as a JID
    // domain ("Login failed. Invalid Jid"), so presence never logs in. The
    // metagame's XMPP listener (src/realtime) answers as prod.ol.epicgames.com
    // on plain TCP 60002.
    if (std::wstring(Section).starts_with(L"OnlineSubsystemMcp.XMPP")) {
        const std::wstring K(Key);
        const std::wstring Host = Globals::MetagameAddress.substr(0, Globals::MetagameAddress.find(L':'));
        const wchar_t* Override = K == L"Domain" ? L"prod.ol.epicgames.com"
            : K == L"ServerAddr" ? Host.c_str()
            : K == L"ServerPort" ? L"60002"
            : K == L"bUseSSL" ? L"False"
            : nullptr;
        if (Override) {
            *Value = FString(Override);
            return true;
        }
        return reinterpret_cast<bool(*)(void* a1, const wchar_t* Section, const wchar_t* Key, FString * Value, FString * Filename)>(OrigConfigCacheIniGetString)(a1, Section, Key, Value, Filename);
    }

    if (std::wstring(Section).contains(L"Mcp")) {
        if (std::wstring(Key).contains(L"protocol") || std::wstring(Key).contains(L"Protocol")) {
            *Value = FString(L"http");

            return true;
        }
        
        if (std::wstring(Key).contains(L"Domain") || std::wstring(Key).contains(L"RedirectUrl")) {
            *Value = FString(Globals::MetagameAddress.c_str());

            return true;
        }
    }
    
    return reinterpret_cast<bool(*)(void* a1, const wchar_t* Section, const wchar_t* Key, FString * Value, FString * Filename)>(OrigConfigCacheIniGetString)(a1, Section, Key, Value, Filename);
}

// ---------------------------------------------------------------------------
// Hunt-unlock diagnostics. Opt-in: inactive unless UNDAUNTED_DIAG_LOG is set to
// a file path prefix, in which case each process writes <prefix>.<role>.<pid>.log.
//
// Why: bounties a player holds are refunded on every world load. The gameserver
// re-validates each one in UBountyComponent::ServerInitializeBounties through
// IsBountyUnlocked, which bottoms out in UHuntCatalog::IsHuntUnlocked (0x14F2A30,
// the function hooked below). The same check passes when drafting, so something
// it depends on is not ready at world load. IsHuntUnlocked fails at the first of:
//
//   A  the player controller is null
//   B  player controller +0x668 (the quest system) is null
//   C  GetSchedulerComponent (0x161E5E0) returns null
//   D  the schedule-active check (0x14713B0) returns false - this one logs nothing
//   E  neither Unlock nor AltUnlock is satisfied (0x14D8B50)
//
// This records which one, per call, tagged with who asked: bounty setup on world
// load (INIT), drafting (DRAFT), or the UI (UI). Diagnostic only - every hook
// forwards its arguments untouched and returns the original result.
#include <mutex>
#include <chrono>
#include <intrin.h>

namespace HuntDiag {
    static bool Enabled = false;
    static std::mutex LogMutex;
    static std::ofstream Log;

    struct CallState {
        bool Active = false;
        int SchedulerCalls = 0;
        bool SchedulerNonNull = false;
        int ScheduleCalls = 0;
        bool ScheduleActive = false;
        int UnlockCalls = 0;
        bool UnlockResults[4] = {};
    };

    static thread_local CallState Current;
    static thread_local const char* BountyContext = nullptr;
    static thread_local std::string BountyId;

    void Init() {
        char Prefix[MAX_PATH] = {};
        DWORD Length = GetEnvironmentVariableA("UNDAUNTED_DIAG_LOG", Prefix, MAX_PATH);

        if (Length == 0 || Length >= MAX_PATH) {
            return;
        }

        // One file per process, so the client and each world server never interleave.
        std::string File = std::string(Prefix) + "." + (Globals::AmServer ? "server" : "client") + "."
            + std::to_string(GetCurrentProcessId()) + ".log";

        Log.open(File, std::ios::app);
        Enabled = Log.is_open();
    }

    void Write(const std::string& Line) {
        if (!Enabled) {
            return;
        }

        std::lock_guard<std::mutex> Lock(LogMutex);

        auto Now = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();

        Log << Now << " " << Line << std::endl;
    }
}

using DiagFn = __int64(*)(__int64, __int64, __int64, __int64, __int64, __int64, __int64, __int64);

// The helpers below are forwarded with eight integer arguments and the original
// is called before anything else happens. That keeps every argument register -
// and any stack arguments - exactly as the caller left them, whatever the real
// signature is. Results are only recorded while an IsHuntUnlocked call is active.

void* OrigGetSchedulerComponent = nullptr;

__int64 GetSchedulerComponentDiag(__int64 a1, __int64 a2, __int64 a3, __int64 a4, __int64 a5, __int64 a6, __int64 a7, __int64 a8) {
    __int64 Result = reinterpret_cast<DiagFn>(OrigGetSchedulerComponent)(a1, a2, a3, a4, a5, a6, a7, a8);

    if (HuntDiag::Current.Active) {
        HuntDiag::Current.SchedulerCalls++;
        HuntDiag::Current.SchedulerNonNull = Result != 0;
    }

    return Result;
}

void* OrigIsScheduleActive = nullptr;

__int64 IsScheduleActiveDiag(__int64 a1, __int64 a2, __int64 a3, __int64 a4, __int64 a5, __int64 a6, __int64 a7, __int64 a8) {
    __int64 Result = reinterpret_cast<DiagFn>(OrigIsScheduleActive)(a1, a2, a3, a4, a5, a6, a7, a8);

    if (HuntDiag::Current.Active) {
        HuntDiag::Current.ScheduleCalls++;
        // A bool comes back in AL; the upper bytes of RAX are not meaningful.
        HuntDiag::Current.ScheduleActive = (Result & 0xFF) != 0;
    }

    return Result;
}

void* OrigCheckUnlockInfo = nullptr;

__int64 CheckUnlockInfoDiag(__int64 a1, __int64 a2, __int64 a3, __int64 a4, __int64 a5, __int64 a6, __int64 a7, __int64 a8) {
    __int64 Result = reinterpret_cast<DiagFn>(OrigCheckUnlockInfo)(a1, a2, a3, a4, a5, a6, a7, a8);

    if (HuntDiag::Current.Active) {
        if (HuntDiag::Current.UnlockCalls < 4) {
            HuntDiag::Current.UnlockResults[HuntDiag::Current.UnlockCalls] = (Result & 0xFF) != 0;
        }

        HuntDiag::Current.UnlockCalls++;
    }

    return Result;
}

void* OrigIsBountyUnlocked = nullptr;

// Return addresses (as offsets from the image base) of the three call sites of
// UBountyComponent::IsBountyUnlocked in this build.
static const uintptr_t IsBountyUnlockedFromInit = 0x13F8883;   // ServerInitializeBounties
static const uintptr_t IsBountyUnlockedFromDraft = 0x13F59F2;  // ServerDraftBounty_Implementation
static const uintptr_t IsBountyUnlockedFromUI = 0x1AD57D7;     // Blueprint-callable exec thunk

__int64 IsBountyUnlockedDiag(__int64 a1, __int64 a2, __int64 a3, __int64 a4, __int64 a5, __int64 a6, __int64 a7, __int64 a8) {
    uintptr_t Caller = (uintptr_t)_ReturnAddress() - Globals::BaseAddress;

    const char* PreviousContext = HuntDiag::BountyContext;
    std::string PreviousId = HuntDiag::BountyId;

    HuntDiag::BountyContext = Caller == IsBountyUnlockedFromInit ? "INIT"
        : Caller == IsBountyUnlockedFromDraft ? "DRAFT"
        : Caller == IsBountyUnlockedFromUI ? "UI"
        : "OTHER";

    // The second argument points at the bounty's row name.
    HuntDiag::BountyId = a2 != 0 ? reinterpret_cast<FName*>(a2)->ToString() : std::string("<null>");

    __int64 Result = reinterpret_cast<DiagFn>(OrigIsBountyUnlocked)(a1, a2, a3, a4, a5, a6, a7, a8);

    HuntDiag::Write(std::string("BOUNTY ctx=") + HuntDiag::BountyContext + " bounty=" + HuntDiag::BountyId
        + " unlocked=" + ((Result & 0xFF) != 0 ? "1" : "0"));

    HuntDiag::BountyContext = PreviousContext;
    HuntDiag::BountyId = PreviousId;

    return Result;
}

void* OrigGetEscalationSeason = nullptr;

// This is UHuntCatalog::IsHuntUnlocked, despite the name.
bool GetEscalationSeason(UHuntCatalog* a1, FString* HuntID, FHunt_UnlockInfo* UnlockInfo, FHunt_UnlockInfo* AltUnlockInfo, AArchonPlayerController* PC) { // TODO: Fixup scheduling & Player leveling so this hack isn't necessary
    auto Original = reinterpret_cast<bool(*)(UHuntCatalog * a1, FString * HuntID, FHunt_UnlockInfo * UnlockInfo, FHunt_UnlockInfo * AltUnlockInfo, AArchonPlayerController * PC)>(OrigGetEscalationSeason);

    bool Instrument = HuntDiag::Enabled && HuntDiag::BountyContext != nullptr;

    if (HuntID->ToString().contains("Arena") || (HuntID->ToString().contains("Esca") && !HuntID->ToString().contains("Mint"))) {
        if (Instrument) {
            HuntDiag::Write(std::string("HUNT ctx=") + HuntDiag::BountyContext + " bounty=" + HuntDiag::BountyId
                + " hunt=" + HuntID->ToString() + " result=1 reason=forced-by-undaunted-hook");
        }

        return true;
    }

    if (!Instrument) {
        return Original(a1, HuntID, UnlockInfo, AltUnlockInfo, PC);
    }

    // A and B are read here, before the original runs, from the same fields it tests.
    bool PcNull = PC == nullptr;
    bool QuestSystemNull = PcNull || *reinterpret_cast<uintptr_t*>(reinterpret_cast<uintptr_t>(PC) + 0x668) == 0;

    HuntDiag::Current = HuntDiag::CallState{};
    HuntDiag::Current.Active = true;

    bool Result = Original(a1, HuntID, UnlockInfo, AltUnlockInfo, PC);

    HuntDiag::Current.Active = false;

    const HuntDiag::CallState& State = HuntDiag::Current;

    const char* Reason = Result ? "ok"
        : PcNull ? "A:player-controller-null"
        : QuestSystemNull ? "B:quest-system-null"
        : (State.SchedulerCalls > 0 && !State.SchedulerNonNull) ? "C:scheduler-component-null"
        : (State.ScheduleCalls > 0 && !State.ScheduleActive) ? "D:schedule-inactive"
        : State.UnlockCalls > 0 ? "E:unlock-requirements-unmet"
        : "unknown";

    std::string Unlocks;
    for (int i = 0; i < State.UnlockCalls && i < 4; i++) {
        Unlocks += State.UnlockResults[i] ? "1" : "0";
    }

    HuntDiag::Write(std::string("HUNT ctx=") + HuntDiag::BountyContext + " bounty=" + HuntDiag::BountyId
        + " hunt=" + HuntID->ToString()
        + " result=" + (Result ? "1" : "0")
        + " reason=" + Reason
        + " scheduler=" + (State.SchedulerCalls == 0 ? "-" : State.SchedulerNonNull ? "ok" : "null")
        + " scheduleActive=" + (State.ScheduleCalls == 0 ? "-" : State.ScheduleActive ? "1" : "0")
        + " unlockChecks=" + (Unlocks.empty() ? "-" : Unlocks));

    return Result;
}

// Installed only when diagnostics are enabled, after MH_Initialize.
void InstallHuntDiagHooks() {
    if (!HuntDiag::Enabled) {
        return;
    }

    MH_CreateHook((void*)(Globals::BaseAddress + 0x13DAB60), IsBountyUnlockedDiag, &OrigIsBountyUnlocked);
    MH_EnableHook((void*)(Globals::BaseAddress + 0x13DAB60));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x161E5E0), GetSchedulerComponentDiag, &OrigGetSchedulerComponent);
    MH_EnableHook((void*)(Globals::BaseAddress + 0x161E5E0));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x14713B0), IsScheduleActiveDiag, &OrigIsScheduleActive);
    MH_EnableHook((void*)(Globals::BaseAddress + 0x14713B0));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x14D8B50), CheckUnlockInfoDiag, &OrigCheckUnlockInfo);
    MH_EnableHook((void*)(Globals::BaseAddress + 0x14D8B50));

    HuntDiag::Write(std::string("diagnostics enabled, role=") + (Globals::AmServer ? "server" : "client"));
}

void* OrigGetTrackProgress = nullptr;

// The 1.4.4 linked-slayer heartbeat refreshes friend availability but never
// asks for invitations or the current link slots; the live service pushed
// those changes instead. Refresh the invitations on every heartbeat
// (RefreshLinkedSlayerInvitesData, +0x15FAE30).
//
// Poll slots too: cancellation and late prize pools need not change the
// invitation list at all. Deduplicate the social-list add notification below
// instead of suppressing slot refreshes (which left the partner's UI stale).
void* OrigRefreshFriendsLinksDisponibility = nullptr;
void* OrigSocialListUserAdded = nullptr;
void* OrigSlayerLinkDataReceived = nullptr;

// The service's accepted link is authoritative. Merely polling it updates
// slot data, but the native pool generator is wired to SlotActivated, which
// normally depends on an invitation transition and can be missed (or expire
// while the inviter is offline). Re-arm the native activation marker when a
// returned link has no pool. The original handler performs all event/RPC/UI
// work; we neither roll rewards nor synthesize ownership here.
// 1.4.4 online row: stride 0x68, slot +0x48, pool TArray +0x50,
// end date +0x30. UArchonLinkedSlayers activation marker: +0x148.
static void RecoverMissingLinkPool(uint8_t* LinkedSlayers, const uint8_t* Rows) {
    static const void* LastOwner = nullptr;
    static uint64_t LastAttempt[3] = {};
    static int64_t LastEnd[3] = {};
    __try {
        if (!LinkedSlayers || !Rows) return;
        const uint8_t* Data = *(const uint8_t* const*)Rows;
        const int32_t Num = *(const int32_t*)(Rows + 8);
        if (!Data || Num < 1 || Num > 3) return;
        if (LastOwner != LinkedSlayers) {
            LastOwner = LinkedSlayers;
            for (int Index = 0; Index < 3; ++Index) { LastAttempt[Index] = 0; LastEnd[Index] = 0; }
        }
        const uint64_t Now = GetTickCount64();
        for (int32_t Index = 0; Index < Num; ++Index) {
            const uint8_t* Row = Data + (size_t)Index * 0x68;
            const int32_t Slot = *(const int32_t*)(Row + 0x48);
            if (Slot < 1 || Slot > 3) continue;
            const int64_t End = *(const int64_t*)(Row + 0x30);
            const int32_t PoolNum = *(const int32_t*)(Row + 0x58);
            if (PoolNum != 0 || End <= 0) continue;
            const int32_t Marker = *(const int32_t*)(LinkedSlayers + 0x148);
            if (Marker >= 1 && Marker <= 3 && Marker != Slot) continue;
            if (LastEnd[Slot - 1] == End && LastAttempt[Slot - 1] && Now - LastAttempt[Slot - 1] < 30000) continue;
            LastEnd[Slot - 1] = End;
            LastAttempt[Slot - 1] = Now;
            *(int32_t*)(LinkedSlayers + 0x148) = Slot;
            return; // Native has one activation marker; other slots retry on the next poll.
        }
    }
    __except (EXCEPTION_EXECUTE_HANDLER) { }
}

// UArchonLinkedSlayers' invite handler (+0x1607670) compares each response
// with the invites it already holds and adds a request row to the social UI
// for every invite it considers new. The live service only called it when
// something changed; here the heartbeat polls every few seconds. An identical
// response is skipped as a guard: same count and, per invite
// (FSlayerLinkInviteOnlineData, 0x50 bytes), the same direction (+0x28),
// status (+0x29), expiry (+0x30) and link id (FString at +0x38). (The
// duplicated invite rows seen in testing came from the backend's heartbeat
// status answering with empty lists, fixed in the metagame.)
void* OrigSlayerLinkInvitesReceived = nullptr;

static bool InviteRowsSignature(const uint8_t* Rows, uint64_t* Out) {
    __try {
        if (!Rows)
            return false;
        const uint8_t* Data = *(const uint8_t* const*)Rows;
        const int32_t Num = *(const int32_t*)(Rows + 8);
        if (Num < 0 || Num > 64 || (Num > 0 && !Data))
            return false;
        uint64_t Hash = 1469598103934665603ull ^ (uint64_t)(uint32_t)Num;
        for (int32_t Index = 0; Index < Num; ++Index) {
            const uint8_t* Row = Data + (size_t)Index * 0x50;
            Hash = (Hash ^ Row[0x28]) * 1099511628211ull;
            Hash = (Hash ^ Row[0x29]) * 1099511628211ull;
            Hash = (Hash ^ *(const uint64_t*)(Row + 0x30)) * 1099511628211ull;
            const wchar_t* LinkId = *(const wchar_t* const*)(Row + 0x38);
            const int32_t LinkIdNum = *(const int32_t*)(Row + 0x40);
            if (LinkId && LinkIdNum > 0 && LinkIdNum < 128)
                for (int32_t Char = 0; Char < LinkIdNum && LinkId[Char]; ++Char)
                    Hash = (Hash ^ (uint64_t)LinkId[Char]) * 1099511628211ull;
        }
        *Out = Hash;
        return true;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

void SlayerLinkInvitesReceivedHook(void* LinkedSlayers, void* Rows) {
    static const void* LastOwner = nullptr;
    static uint64_t LastSignature = 0;
    uint64_t Signature = 0;
    if (InviteRowsSignature(static_cast<const uint8_t*>(Rows), &Signature)) {
        if (LastOwner == LinkedSlayers && LastSignature == Signature)
            return;
        LastOwner = LinkedSlayers;
        LastSignature = Signature;
    }
    reinterpret_cast<void(*)(void*, void*)>(OrigSlayerLinkInvitesReceived)(LinkedSlayers, Rows);
}

void SlayerLinkDataReceivedHook(void* LinkedSlayers, void* Rows) {
    RecoverMissingLinkPool(static_cast<uint8_t*>(LinkedSlayers), static_cast<const uint8_t*>(Rows));
    reinterpret_cast<void(*)(void*, void*)>(OrigSlayerLinkDataReceived)(LinkedSlayers, Rows);
}

// Verified in 1.4.4 at +0x15BE720: rdx is UArchonSocialUserInternal,
// +0x168 is its public user. The method blindly appends that pointer to the
// UArchonSocialUserList::Users array (+0x38), then broadcasts an addition.
// A repeat notification is a no-op; real additions and native removals still
// use the original implementation, including its UI notifications.
static bool SocialListAlreadyContains(const uint8_t* List, const uint8_t* InternalUser) {
    __try {
        if (!List || !InternalUser)
            return false;
        const void* User = *(const void* const*)(InternalUser + 0x168);
        const void* const* Users = *(const void* const* const*)(List + 0x38);
        const int32_t Num = *(const int32_t*)(List + 0x40);
        const int32_t Max = *(const int32_t*)(List + 0x44);
        if (!User || Num < 0 || Num > Max || Num > 4096 || (Num && !Users))
            return false;
        for (int32_t Index = 0; Index < Num; ++Index)
            if (Users[Index] == User) return true;
        return false;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

void SocialListUserAddedHook(void* List, void* InternalUser) {
    if (!SocialListAlreadyContains(static_cast<const uint8_t*>(List), static_cast<const uint8_t*>(InternalUser)))
        reinterpret_cast<void(*)(void*, void*)>(OrigSocialListUserAdded)(List, InternalUser);
}

void RefreshFriendsLinksDisponibilityHook(void* LinkedSlayers) {
    reinterpret_cast<void(*)(void*)>(OrigRefreshFriendsLinksDisponibility)(LinkedSlayers);
    if (!LinkedSlayers)
        return;

    reinterpret_cast<void(*)(void*)>(Globals::BaseAddress + 0x15FAE30)(LinkedSlayers);

    reinterpret_cast<void(*)(void*)>(Globals::BaseAddress + 0x15FAB10)(LinkedSlayers);
}

__int64 GetTrackProgress(void* a1, FName* a2, void* a3) {
    if (a2) {
        std::cout << a2->ToString() << std::endl;
    }

    return 9999999;
}

//__int64 *__fastcall sub_141428060(__int64 a1, __int64 *a2, unsigned __int8 a3, char a4)

void InitClientHooks() {
    MH_Initialize();

    MH_CreateHook((void*)(Globals::BaseAddress + 0x28A76C0), ClientProcessRequest, &OrigProcessRequest);
    MH_EnableHook((void*)(Globals::BaseAddress + 0x28A76C0));
    MH_CreateHook((void*)(Globals::BaseAddress + 0x15BE720), SocialListUserAddedHook, &OrigSocialListUserAdded);
    MH_EnableHook((void*)(Globals::BaseAddress + 0x15BE720));
    MH_CreateHook((void*)(Globals::BaseAddress + 0x1607E90), SlayerLinkDataReceivedHook, &OrigSlayerLinkDataReceived);
    MH_EnableHook((void*)(Globals::BaseAddress + 0x1607E90));
    MH_CreateHook((void*)(Globals::BaseAddress + 0x1607670), SlayerLinkInvitesReceivedHook, &OrigSlayerLinkInvitesReceived);
    MH_EnableHook((void*)(Globals::BaseAddress + 0x1607670));

    // This method is called once per linked-slayer heartbeat (about every
    // five seconds), after the client has initialized its online subsystem.
    MH_CreateHook((void*)(Globals::BaseAddress + 0x15FA600), RefreshFriendsLinksDisponibilityHook, &OrigRefreshFriendsLinksDisponibility);
    MH_EnableHook((void*)(Globals::BaseAddress + 0x15FA600));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x1528000), HasFinishedLoadingHook, &OrigHasFinishedLoading);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x1528000));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x1D09D50), ConfigCacheInitGetStringHook, &OrigConfigCacheIniGetString);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x1D09D50));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x14F2A30), GetEscalationSeason, &OrigGetEscalationSeason);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x14F2A30));

    //

    //1469E00

    //MH_CreateHook((void*)(Globals::BaseAddress + 0x1469E00), GetTrackProgress, &OrigGetTrackProgress);

    //MH_EnableHook((void*)(Globals::BaseAddress + 0x1469E00));


    //MH_CreateHook((void*)(Globals::BaseAddress + 0x347E110), IsNetReadyHook, &OrigIsNetReady);

    //MH_EnableHook((void*)(Globals::BaseAddress + 0x347E110));

    //MH_CreateHook((void*)(Globals::BaseAddress + 0x1F61820), ProcessEventClientHook, &OrigProcessEventClient);

    //MH_EnableHook((void*)(Globals::BaseAddress + 0x1F61820));

   // MH_CreateHook((void*)(Globals::BaseAddress + 0x3077710), GetActorCallspace, &OrigGetActorCallspace);

   // MH_EnableHook((void*)(Globals::BaseAddress + 0x3077710));
}

void* OrigSprint = nullptr;

bool SprintHook(uintptr_t a1, uintptr_t a2) { //char __fastcall UArchonStaminaComponent_TryConsumeStamina_Native(__int64 a1, __int64 a2, char a3, char a4)    
    return true;
}

void* OrigNetModeHook = nullptr;

int NetModeHook(void* a1) { //char __fastcall UArchonStaminaComponent_TryConsumeStamina_Native(__int64 a1, __int64 a2, char a3, char a4)   
    return 1;
}

void InitServerHooks() {
    MH_Initialize();

    MH_CreateHook((void*)(Globals::BaseAddress + 0x1D09D50), ConfigCacheInitGetStringHook, &OrigConfigCacheIniGetString);
    MH_EnableHook((void*)(Globals::BaseAddress + 0x1D09D50));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x25A37C0), GetGameDefaultMap, &OrigGetDefaultMap);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x25A37C0));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x1D06D40), GetCommandLineHook, &OrigGetCommandLine);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x1D06D40));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x2E4D7F0), ServerBootCrash, &OrigServerBootCrash);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x2E4D7F0));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x1658f90), EncounterableSetupHook, &OrigEncounterableSetup);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x1658f90));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x3307100), GameEngineTickHook, &OrigGameEngineTick);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x3307100));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x820120), FixupNetworkNotifyHook, &OrigFixupNetworkNotify);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x820120));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x28A76C0), ProcessRequest, &OrigProcessRequest);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x28A76C0));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x1390300), EncounterableSetupHook, &OrigEncounterableSetup); // TODO: Rename to combat text

    MH_EnableHook((void*)(Globals::BaseAddress + 0x1390300));

    //MH_CreateHook((void*)(Globals::BaseAddress + 0x3077710), GetActorCallspace, &OrigGetActorCallspace);

    //MH_EnableHook((void*)(Globals::BaseAddress + 0x3077710));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x14B7460), PostLoginHook, &OrigPostLogin);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x14B7460));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x1528000), HasFinishedLoadingHook, &OrigHasFinishedLoading);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x1528000));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x347E110), IsNetReadyHook, &OrigIsNetReady);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x347E110));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x3491720), SetReplicationDriverHook, &OrigSetReplicationDriver);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x3491720));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x3078AF0), GetNetDriverInternalHook, &OrigGetNetDriverInternal);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x3078AF0));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x3458780), IsLevelInitForActorHook, &OrigIsLevelInitForActor);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x3458780));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x1368660), GetStartSpotHook, &OrigGetStartSpot);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x1368660));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x1F61820), ProcessEventHook, &OrigProcessEvent);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x1F61820));

    //MH_CreateHook((void*)(Globals::BaseAddress + 0x35996D0), MakeDoDamageHook, &OrigMakeDoDamage);

    //MH_EnableHook((void*)(Globals::BaseAddress + 0x35996D0));

    //MH_CreateHook((void*)(Globals::BaseAddress + 0x137A800), SprintHook, &OrigSprint);

    //MH_EnableHook((void*)(Globals::BaseAddress + 0x137A800));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x378BDA0), NetModeHook, &OrigNetModeHook);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x378BDA0));

    //MH_CreateHook((void*)(Globals::BaseAddress + 0x1469E00), GetTrackProgress, &OrigGetTrackProgress);

   // MH_EnableHook((void*)(Globals::BaseAddress + 0x1469E00));

    
    MH_CreateHook((void*)(Globals::BaseAddress + 0x14F2A30), GetEscalationSeason, &OrigGetEscalationSeason);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x14F2A30));

    //

    //13CA280

    //GetStartSpotHook

    // Fixup Listen failure
    DWORD oldProtect;
    VirtualProtect((void*)(Globals::BaseAddress + 0x372E746), 0x5, PAGE_READWRITE, &oldProtect);

    *(uint8_t*)(Globals::BaseAddress + 0x372E746 + 0x0) = 0xB0;
    *(uint8_t*)(Globals::BaseAddress + 0x372E746 + 0x1) = 0x01;
    *(uint8_t*)(Globals::BaseAddress + 0x372E746 + 0x2) = 0x90;
    *(uint8_t*)(Globals::BaseAddress + 0x372E746 + 0x3) = 0x90;
    *(uint8_t*)(Globals::BaseAddress + 0x372E746 + 0x4) = 0x90;

    VirtualProtect((void*)(Globals::BaseAddress + 0x372E746), 0x5, oldProtect, &oldProtect);

    // Fixup Ramsgate Crash
    VirtualProtect((void*)(Globals::BaseAddress + 0x1346A98), 0x7, PAGE_READWRITE, &oldProtect);

    *(uint8_t*)(Globals::BaseAddress + 0x1346A98 + 0x0) = 0x33;
    *(uint8_t*)(Globals::BaseAddress + 0x1346A98 + 0x1) = 0xF6;
    *(uint8_t*)(Globals::BaseAddress + 0x1346A98 + 0x2) = 0x33;
    *(uint8_t*)(Globals::BaseAddress + 0x1346A98 + 0x3) = 0xC0;
    *(uint8_t*)(Globals::BaseAddress + 0x1346A98 + 0x4) = 0x90;
    *(uint8_t*)(Globals::BaseAddress + 0x1346A98 + 0x5) = 0x90;
    *(uint8_t*)(Globals::BaseAddress + 0x1346A98 + 0x6) = 0x90;

    VirtualProtect((void*)(Globals::BaseAddress + 0x1346A98), 0x7, oldProtect, &oldProtect);

    //GIsServer and GIsClient
    VirtualProtect((void*)(Globals::BaseAddress + 0x7961AE), 0x9, PAGE_READWRITE, &oldProtect);

    *(uint8_t*)(Globals::BaseAddress + 0x7961AE + 0x0) = 0xC6;
    *(uint8_t*)(Globals::BaseAddress + 0x7961AE + 0x1) = 0x05;
    *(uint8_t*)(Globals::BaseAddress + 0x7961AE + 0x2) = 0x84;
    *(uint8_t*)(Globals::BaseAddress + 0x7961AE + 0x3) = 0x5A;
    *(uint8_t*)(Globals::BaseAddress + 0x7961AE + 0x4) = 0x6B;
    *(uint8_t*)(Globals::BaseAddress + 0x7961AE + 0x5) = 0x05;
    *(uint8_t*)(Globals::BaseAddress + 0x7961AE + 0x6) = 0x00;
    *(uint8_t*)(Globals::BaseAddress + 0x7961AE + 0x7) = 0x90;
    *(uint8_t*)(Globals::BaseAddress + 0x7961AE + 0x8) = 0x90;

    VirtualProtect((void*)(Globals::BaseAddress + 0x7961AE), 0x9, oldProtect, &oldProtect);

    VirtualProtect((void*)(Globals::BaseAddress + 0x7961BB), 0x9, PAGE_READWRITE, &oldProtect);

    *(uint8_t*)(Globals::BaseAddress + 0x7961BB + 0x0) = 0xC6;
    *(uint8_t*)(Globals::BaseAddress + 0x7961BB + 0x1) = 0x05;
    *(uint8_t*)(Globals::BaseAddress + 0x7961BB + 0x2) = 0x78;
    *(uint8_t*)(Globals::BaseAddress + 0x7961BB + 0x3) = 0x5A;
    *(uint8_t*)(Globals::BaseAddress + 0x7961BB + 0x4) = 0x6B;
    *(uint8_t*)(Globals::BaseAddress + 0x7961BB + 0x5) = 0x05;
    *(uint8_t*)(Globals::BaseAddress + 0x7961BB + 0x6) = 0x01;
    *(uint8_t*)(Globals::BaseAddress + 0x7961BB + 0x7) = 0x90;
    *(uint8_t*)(Globals::BaseAddress + 0x7961BB + 0x8) = 0x90;

    VirtualProtect((void*)(Globals::BaseAddress + 0x7961BB), 0x9, oldProtect, &oldProtect);

    VirtualProtect((void*)(Globals::BaseAddress + 0x79A81B), 0x7, PAGE_READWRITE, &oldProtect);

    *(uint8_t*)(Globals::BaseAddress + 0x79A81B + 0x0) = 0xC6;
    *(uint8_t*)(Globals::BaseAddress + 0x79A81B + 0x1) = 0x05;
    *(uint8_t*)(Globals::BaseAddress + 0x79A81B + 0x2) = 0x17;
    *(uint8_t*)(Globals::BaseAddress + 0x79A81B + 0x3) = 0x14;
    *(uint8_t*)(Globals::BaseAddress + 0x79A81B + 0x4) = 0x6B;
    *(uint8_t*)(Globals::BaseAddress + 0x79A81B + 0x5) = 0x05;
    *(uint8_t*)(Globals::BaseAddress + 0x79A81B + 0x6) = 0x00;

    VirtualProtect((void*)(Globals::BaseAddress + 0x79A81B), 0x7, oldProtect, &oldProtect);

    VirtualProtect((void*)(Globals::BaseAddress + 0x79A680), 0x1, PAGE_READWRITE, &oldProtect);

    *(uint8_t*)(Globals::BaseAddress + 0x79A680 + 0x0) = 0x00;

    VirtualProtect((void*)(Globals::BaseAddress + 0x79A680), 0x1, oldProtect, &oldProtect);

    VirtualProtect((void*)(Globals::BaseAddress + 0x79A815), 0x1, PAGE_READWRITE, &oldProtect);

    *(uint8_t*)(Globals::BaseAddress + 0x79A815 + 0x0) = 0x01;

    VirtualProtect((void*)(Globals::BaseAddress + 0x79A815), 0x1, oldProtect, &oldProtect);
}

void Init() {

    Globals::AmServer = std::string(GetCommandLineA()).contains("-server");
    Globals::BaseAddress = (uintptr_t)GetModuleHandleA(nullptr);

    if (Globals::AmServer) {
        *(uint8_t*)(Globals::BaseAddress + 0x5E4BC3A) = 0x1; // GIsServer
        *(uint8_t*)(Globals::BaseAddress + 0x5E4BC39) = 0x0; // GIsClient
    }

    UC::FMemory::Init((void*)(Globals::BaseAddress + 0x1C8EE00));

    if (Globals::AmServer) {
        int NumArgs = 0;

        wchar_t** Args = CommandLineToArgvW(GetCommandLineW(), &NumArgs);

        if (NumArgs > 9) {
            Globals::ServerAPIKey = Args[1];
            Globals::Port = std::stoi(std::wstring(Args[2]));
            Globals::MapPath = Args[3];
            Globals::BehemothPath = Args[4];
            Globals::MatchmakerHuntId = Args[5];
            Globals::ExpectedPlayerString = Args[6];
            Globals::MyIpAndPort = Args[7];
            Globals::MetagameAddress = Args[8];

            if (Globals::Port >= 8776) {
                EnableWatchdog = false;
                Globals::EnableLogging = true;
            }
        }
        else {
            MessageBoxA(nullptr, "INVALID GAMESERVER ARGS", "INVALID GAMESERVER ARGS", 0);
            exit(0);
            return;
        }

        if (Globals::EnableLogging) {
            AllocConsole();
            FILE* Dummy;
            freopen_s(&Dummy, "CONOUT$", "w", stdout);
            freopen_s(&Dummy, "CONIN$", "r", stdin);

            std::cout << "Welcome to Undaunted v" << UNDAUNTED_INTERNAL_VERSION << "!" << std::endl;
            std::cout << "prod. gwog :3" << std::endl;
            std::cout << "thanks to all who contributed in any way, you know who you are, dm me on discord if you want a named shoutout here :3" << std::endl;

            std::cout << "Running as a server!" << std::endl;
        }

        HuntDiag::Init();
        InitServerHooks();
        InstallHuntDiagHooks();
    }
    else {
        Globals::EnableLogging = true;

        if (Globals::EnableLogging) {
            AllocConsole();
            FILE* Dummy;
            freopen_s(&Dummy, "CONOUT$", "w", stdout);
            freopen_s(&Dummy, "CONIN$", "r", stdin);

            std::cout << "Welcome to Undaunted v" << UNDAUNTED_INTERNAL_VERSION << "!" << std::endl;
            std::cout << "prod. gwog :3" << std::endl;
            std::cout << "thanks to all who contributed in any way, you know who you are, dm me on discord if you want a named shoutout here :3" << std::endl;

            std::cout << "Running as a debug-enabled client!" << std::endl;
        }

        int NumArgs = 0;

        wchar_t** Args = CommandLineToArgvW(GetCommandLineW(), &NumArgs);

        if (NumArgs > 2) {
            Globals::MetagameAddress = Args[1];
        }

        HuntDiag::Init();
        InitClientHooks();
        InstallHuntDiagHooks();
    }

    DWORD threadId;
    CreateThread(nullptr, 0x1000, (LPTHREAD_START_ROUTINE)MainThread, nullptr, 0, &threadId);
}

BOOL APIENTRY DllMain( HMODULE hModule,
                       DWORD  ul_reason_for_call,
                       LPVOID lpReserved
                     )
{
    switch (ul_reason_for_call)
    {
    case DLL_PROCESS_ATTACH:
        DisableThreadLibraryCalls(hModule);
        Init();
    case DLL_THREAD_ATTACH:
    case DLL_THREAD_DETACH:
    case DLL_PROCESS_DETACH:
        break;
    }
    return TRUE;
}

