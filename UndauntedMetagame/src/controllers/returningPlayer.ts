// Start 1.12.0 characters as returning players.
//
// A new 1.12.0 character is sent to the first-time tutorial island
// (dia_moss_triforce, BPGM_ArchonIslandTutorial), and the client leaves that
// server about a second after joining it. Mystic Paradox does not run the
// tutorial at all: it presents every character as having finished character
// creation and entered Ramsgate, so the client goes straight there. This is
// that normalisation, adapted from Mystic Paradox's ParadoxBackend
// (pranav158/Mystic-Paradox@355934c src/controllers/character.ts:
// NormalizeCharacterData / ForceReturningPlayerState); see NOTICE.md.
//
// Enabled with SKIP_FTUE=true (the 1.12 instance). The 1.4.4 client keeps its
// own onboarding untouched.
export const SKIP_FTUE = process.env.SKIP_FTUE === "true";

const TARGET_CHANGELIST = process.env.TARGET_CHANGELIST;

const PROGRESS_ORDER: Record<string, number> = {
    New: 0, DefeatedGnasher: 1, SavedCharacter: 2, EnteredRamsgate: 3,
    FinishedFirstHunt: 4, FinishedSecondHunt: 5, Final: 5
};

// Appearance used when a character never went through the creation screen.
function DefaultAppearance(){
    return {
        CreationState: "EArchonCharacterCreationState::FaceComplete",
        Data: [{ SkeletalMeshComponentName: "Head Slot", MorphData: [] }],
        AssetReferences: [],
        StringData: [
            { Key: "BodyType", Data: "Feminine" },
            { Key: "Hair", Data: "Hair12" },
            { Key: "SkinName", Data: "Tan" },
            { Key: "SkinValue", Data: "(R=0.610496,G=0.417885,B=0.254152,A=1.000000)" },
            { Key: "Hair_Color", Data: "(R=0.196843,G=0.042531,B=0.019093,A=1.000000)" },
            { Key: "Beard", Data: "NoBeard" },
            { Key: "Facepaint", Data: "NoFacepaint" },
            { Key: "Makeup", Data: "NoMakeup" }
        ]
    };
}

// Tutorial pop-ups a returning player has already dismissed.
const TUTORIAL_SLATE_FLAGS = [
    "TutorialSlate_LanternAbility", "TutorialSlate_QuickAttack", "TutorialSlate_HeavyAttack",
    "TutorialSlate_Dodge", "TutorialSlate_LockOn", "TutorialSlate_Sprint",
    "TutorialSlate_Consumables", "TutorialSlate_Interact", "TutorialSlate_Chat",
    "TutorialSlate_Emote", "TutorialSlate_Menu", "TutorialSlate_Inventory",
    "TutorialSlate_Loadout", "TutorialSlate_Store", "TutorialSlate_HuntPass",
    "TutorialSlate_Map", "TutorialSlate_Party", "CharacterFlag_CityGatherableTutorialShown"
];

function ParseObject(Value: unknown): any {
    if(Value != null && typeof Value === "object") return Value;
    if(typeof Value !== "string") return null;
    try{ return JSON.parse(Value); } catch { return null; }
}
function EnsureFlags(Encoded: unknown, Keys: string[], Value: string){
    const Flags = ParseObject(Encoded) ?? { Flags: [] };
    if(!Array.isArray(Flags.Flags)) Flags.Flags = [];
    const Have = new Set(Flags.Flags.map((Flag: any) => Flag?.FlagKey));
    for(const Key of Keys) if(!Have.has(Key)) Flags.Flags.push({ FlagKey: Key, FlagValue: Value });
    return JSON.stringify(Flags);
}
function LoginTimeNow(){
    const Now = new Date(), P = (N: number) => String(N).padStart(2, "0");
    return `${Now.getUTCFullYear()}.${P(Now.getUTCMonth() + 1)}.${P(Now.getUTCDate())}-${P(Now.getUTCHours())}.${P(Now.getUTCMinutes())}.${P(Now.getUTCSeconds())}`;
}

// Takes and returns the character blob as stored (a JSON object of strings).
export function NormalizeReturningPlayer(Encoded: string){
    const Data = ParseObject(Encoded || "{}") ?? {};
    const Series = (Id: string) => JSON.stringify({ ID: Id });
    Data.RecentPlayers ??= JSON.stringify({ RecentPlayers: [], Version: 0 });
    Data.PlayerDataRepair ??= JSON.stringify({ Data: [] });
    Data.SERIE_cr20_pjm_quests ??= Series("CR20_PJM_Quests");
    Data.SERIE_d24_a_main_quests ??= Series("D24_A_MAIN_QUESTS");
    Data.SERIE_d24_b_side_quests ??= Series("D24_B_SIDE_QUESTS");
    Data.SERIE_d24_d_tutorials ??= Series("D24_D_TUTORIALS");
    const Login = LoginTimeNow();
    Data.LoginTime ??= Login;
    Data.LastLoginTime ??= Login;
    if(TARGET_CHANGELIST) Data.LastChangelist = TARGET_CHANGELIST;

    if((PROGRESS_ORDER[String(Data.PlayerAccountProgressStep ?? "New")] ?? 0) < PROGRESS_ORDER.EnteredRamsgate){
        Data.PlayerAccountProgressStep = "EnteredRamsgate";
    }
    // Not in Mystic Paradox: the progress step alone still sends PLAY to the
    // tutorial island; a character that finished it carries this key (as the
    // 1.4.4 characters here do).
    Data.HasFinishedTutorial = "true";
    // Keep a real appearance, but mark creation finished so the client does
    // not send the character back to the creation flow.
    const Appearance = ParseObject(Data.AppearanceData) ?? DefaultAppearance();
    Appearance.CreationState = "EArchonCharacterCreationState::FaceComplete";
    const Default = DefaultAppearance();
    if(!Array.isArray(Appearance.Data) || Appearance.Data.length === 0) Appearance.Data = Default.Data;
    const LegacyStrings = Array.isArray(Appearance.StringData)
        && Appearance.StringData.some((Entry: any) => Entry && ("CustomizationName" in Entry || "ValueName" in Entry || !("Key" in Entry)));
    if(!Array.isArray(Appearance.StringData) || Appearance.StringData.length === 0 || LegacyStrings) Appearance.StringData = Default.StringData;
    if(!Array.isArray(Appearance.AssetReferences)) Appearance.AssetReferences = [];
    Data.AppearanceData = JSON.stringify(Appearance);

    Data.CharacterFlagData = EnsureFlags(Data.CharacterFlagData, TUTORIAL_SLATE_FLAGS, "True");
    Data.LoginFlagData = EnsureFlags(Data.LoginFlagData, ["WatchedNewRamsgateCinematic"], "true");
    return JSON.stringify(Data);
}
