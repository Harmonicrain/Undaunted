import { and, eq, sql } from "drizzle-orm";
import { GetDb } from "../db";
import { loadouts } from "../db/schema";
import { logger } from "../logger";

const DEFAULT_INSTANCE_DATA = JSON.stringify({
    SheenType: 73,
    IsPrimarySheenActive: true,
    PrimaryDyeId: "None",
    IsSecondarySheenActive: true,
    SecondaryDyeId: "None",
    IsTertiarySheenActive: false,
    TertiaryDyeId: "None",
    TransmogCatalogId: "None",
    TransmogEnabled: false,
    EquippedCells: [],
    EquippedCellsv2: [],
    SubTypeMetadataArray: {
        ItemSubType: "subtype_eblade",
        EquippedItemParts: [{
            WeaponPartId: "PART_EB_SPECIAL_DEFAULT",
            SlotIndex: 0,
        }]
    }
});

const DEFAULT_PERSISTENT = {
    manual_emotes: ["", "", "", "", "", ""],
    intro_emote: "EM_INTRO_BEGINNER_01",
    banner: "BN_BEGINNER_00",
    bannerCustomization: "{\"BannerMeshItemID\":\"BNC_MESH_BEGINNER_00\",\"FabricMaterialItemID\":\"BNC_FABRIC_BEGINNER_00\",\"SigilTextureItemID\":\"BNC_SIGIL_BEGINNER_00\",\"PlantVFXItemID\":\"\",\"PersistantStandardVFXItemID\":\"\",\"AnimationItemID\":\"BNC_ANIMATION_BEGINNER_00\",\"BackgroundColourItemID\":\"DYE_BANNER_BACKGROUND_DEFAULT\",\"BorderColourItemID\":\"DYE_BANNER_SIGIL_DEFAULT\",\"SigilColourItemID\":\"DYE_BANNER_SIGIL_DEFAULT\",\"BackgroundSheenType\":0,\"BorderSheenType\":0,\"SigilSheenType\":0}",
    flare: "QI_BASIC_FLARE_DURABLE",
    title: "",
    head_accessory: "",
    back_accessory: "",
    pet: "",
    glider: "GD_FRAME_STARTER_BASE",
    update_version: 0,
    quick_chats: ["", "", "", "", "", "", "", "", ""],
    emojis: ["", "", "", "", "", "", "", "", ""],
    quick_curiosities_items: Array.from({length: 8}, (_, item_index) => ({
        item_index,
        item_id: "",
        instance_id: "",
    })),
    quickwheel: [],
};

// The gameserver asks to unlock a specific number of character loadout slots
// during travel. Slot count is derived from the length of the stored loadouts
// array, so this is the upper bound we are willing to grow that array to.
export const MAX_LOADOUT_SLOTS = 8;

function MakeDefaultLoadoutSlot(SlotIndex: number){
    return {
        weapon: {
            item_id: "WP_EB_TRAINING",
            instance_id: "WP_EB_TRAINING",
            instance_data: DEFAULT_INSTANCE_DATA
        },
        helmet: {
            item_id: "AR_UNEQUIPPED_HELM",
            instance_id: "AR_UNEQUIPPED_HELM",
            instance_data: DEFAULT_INSTANCE_DATA
        },
        chest: {
            item_id: "AR_BEGINNER_CHEST",
            instance_id: "AR_BEGINNER_CHEST",
            instance_data: DEFAULT_INSTANCE_DATA
        },
        arms: {
            item_id: "AR_BEGINNER_ARMS",
            instance_id: "AR_BEGINNER_ARMS",
            instance_data: DEFAULT_INSTANCE_DATA
        },
        legs: {
            item_id: "AR_BEGINNER_LEGS",
            instance_id: "AR_BEGINNER_LEGS",
            instance_data: DEFAULT_INSTANCE_DATA
        },
        lantern: {
            item_id: "LT_BASIC",
            instance_id: "LT_BASIC",
            instance_data: DEFAULT_INSTANCE_DATA
        },
        player_role: {
            item_id: "PR_DARKNESS",
            instance_id: "PR_DARKNESS",
            instance_data: DEFAULT_INSTANCE_DATA
        },
        subweapon: null,
        appearance: "{\"CreationState\":\"EArchonCharacterCreationState::NewCharacter\",\"Data\":[],\"AssetReferences\":[],\"StringData\":[]}",
        flask: "FL_HEALING_DEFAULT",
        quick_items: [],
        slot_index: SlotIndex,
        update_version: 0,
        custom_name: "",
        persistent: DEFAULT_PERSISTENT
    };
}

export function ClampSlotCount(Requested: unknown){
    const Parsed = Number.parseInt(String(Requested), 10);

    if(!Number.isFinite(Parsed)){
        return 1;
    }

    return Math.min(Math.max(Parsed, 1), MAX_LOADOUT_SLOTS);
}

export async function GetAllLoadoutsForUserIdAndCharacterId(UserId: string, CharacterId: string){
    let LoadoutDbRow = await GetDb().query.loadouts.findFirst({where: and(eq(loadouts.characterId, CharacterId), eq(loadouts.userId, UserId))});

    let Loadouts;

    if(LoadoutDbRow == undefined){
        logger.info(`Creating new loadout set for userId ${UserId} and characterId ${CharacterId}`);

        const NewLoadoutData = [MakeDefaultLoadoutSlot(0)];

        await GetDb().insert(loadouts).values({
            characterId: CharacterId,
            userId: UserId,
            loadouts: JSON.stringify(NewLoadoutData),
            persistent: JSON.stringify(DEFAULT_PERSISTENT)
        });

        Loadouts = NewLoadoutData;
    }
    else{
        Loadouts = JSON.parse(LoadoutDbRow.loadouts);
    }

    return Loadouts;
}

export async function GetPersistentLoadoutForUserIdAndCharacterId(UserId: string, CharacterId: string){
    // TODO: This will break if it's not called AFTER the GetAllLoadouts call as it has no create-on-nonexistent functionality

    const LoadoutDbRow = await GetDb().query.loadouts.findFirst({where: and(eq(loadouts.characterId, CharacterId), eq(loadouts.userId, UserId))});

    return JSON.parse(LoadoutDbRow!.persistent);
}

// Grows the stored loadouts array until it holds DesiredSlots entries, so that
// an unlock request can be answered with the count the caller actually asked
// for. Returns the resulting loadouts array.
export async function EnsureCharacterSlotCount(UserId: string, CharacterId: string, DesiredSlots: unknown){
    const Loadouts: any[] = await GetAllLoadoutsForUserIdAndCharacterId(UserId, CharacterId); // Also creates the row on first use

    const TargetSlots = ClampSlotCount(DesiredSlots);

    if(Loadouts.length >= TargetSlots){
        return Loadouts;
    }

    for(let SlotIndex = Loadouts.length; SlotIndex < TargetSlots; SlotIndex++){
        Loadouts.push(MakeDefaultLoadoutSlot(SlotIndex));
    }

    await GetDb().update(loadouts).set({
        loadouts: JSON.stringify(Loadouts)
    }).where(and(eq(loadouts.characterId, CharacterId), eq(loadouts.userId, UserId)));

    logger.info(`Grew loadout slots to ${TargetSlots} for userId ${UserId} and characterId ${CharacterId}`);

    return Loadouts;
}

// num_slots in an unlock request is the number of ADDITIONAL slots the caller
// wants, not the desired total. Observed: a character holding 1 slot asks for
// 3, and after being given 3 it asks for 1 more - both are a request to reach
// 4. Treating the value as a total makes the caller re-send forever.
export async function UnlockAdditionalCharacterSlots(UserId: string, CharacterId: string, AdditionalSlots: unknown){
    const Loadouts: any[] = await GetAllLoadoutsForUserIdAndCharacterId(UserId, CharacterId);

    const Requested = Number.parseInt(String(AdditionalSlots), 10);
    const Delta = Number.isFinite(Requested) ? Math.max(Requested, 0) : 0;

    return EnsureCharacterSlotCount(UserId, CharacterId, Loadouts.length + Delta);
}

export async function SetLoadoutDataForUserIdAndCharacterId(UserId: string, CharacterId: string, Index: string, Data: string){
    logger.info(`Attempting to update loadout data Index ${Index}`);

    if(Index === "persistent"){
        await GetDb().update(loadouts).set({
            persistent: Data
        }).where(and(eq(loadouts.characterId, CharacterId), eq(loadouts.userId, UserId)));

        return true;
    }

    const SlotIndex = Number.parseInt(Index, 10);

    if(!Number.isInteger(SlotIndex) || SlotIndex < 0 || SlotIndex >= MAX_LOADOUT_SLOTS){
        logger.error(`Unsupported Loadout Data Index ${Index}`);
        return false;
    }

    // SQLite json_set appends at array length and silently no-ops past it:
    // https://www.sqlite.org/json1.html#jins - so make sure the slot exists first.
    await EnsureCharacterSlotCount(UserId, CharacterId, SlotIndex + 1);

    await GetDb().update(loadouts).set({
        loadouts: sql`json_set(${loadouts.loadouts}, ${`$[${SlotIndex}]`}, json(${Data}))`
    }).where(and(eq(loadouts.characterId, CharacterId), eq(loadouts.userId, UserId)));

    return true;
}
