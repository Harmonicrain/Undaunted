import { and, eq, lte } from "drizzle-orm";
import { GetDb } from "../db";
import { characters } from "../db/schema";
import { GetUsernameForUserId } from "./login";
import { logger } from "../logger";
import { NormalizeReturningPlayer, SKIP_FTUE } from "./returningPlayer";

function TransformDbCharacterToWireCharacter(DbCharacter: any){
    return {
        accountId: DbCharacter.userId,
        createdDate: DbCharacter.createdDate,
        data: SKIP_FTUE ? NormalizeReturningPlayer(DbCharacter.data) : DbCharacter.data,
        id: DbCharacter.characterId,
        lastModifiedDate: DbCharacter.lastModifiedDate,
        name: DbCharacter.name,
        updateVersion: DbCharacter.updateVersion
    };
}

function IsEmptyCharacterData(Data: unknown){
    if(Data == undefined || (typeof Data === "string" && Data.trim() === "")) return true;
    try{
        const Parsed = typeof Data === "string" ? JSON.parse(Data) : Data;
        return Parsed == undefined || (typeof Parsed === "object" && Object.keys(Parsed).length === 0);
    } catch {
        return false;
    }
}

export async function DoesCharacterBelongToUserId(UserId: string, CharacterId: string){
    const Character = await GetDb().query.characters.findFirst({
        columns: { characterId: true },
        where: and(eq(characters.characterId, CharacterId), eq(characters.userId, UserId))
    });

    return Character != undefined;
}

export async function GetCharactersForUid(userId: string){
    let CharactersFromDb = await GetDb().query.characters.findMany({where: eq(characters.userId, userId)});

    if(CharactersFromDb.length === 0){
        const Username = await GetUsernameForUserId(userId);

        await CreateCharacterForUid(userId, Username);

        CharactersFromDb = await GetDb().query.characters.findMany({where: eq(characters.userId, userId)});
    }

    return CharactersFromDb.map((DbCharacter) => TransformDbCharacterToWireCharacter(DbCharacter));
}

function ProcessTriggers(CharacterDataToUpdateWith: string){
    const CharacterData = JSON.parse(CharacterDataToUpdateWith);

    if(CharacterData.SERIE_cr19_series_1_ftue != undefined){
        const FTUESerieData = JSON.parse(CharacterData.SERIE_cr19_series_1_ftue);

        if(FTUESerieData["929A333B40E413C41E47B0A425EC3349"].Status === 3 && CharacterData["SERIE_dojo"] == undefined){
            logger.info(`Injecting SERIE_dojo!`);

            CharacterData["SERIE_dojo"] = "{\"ID\":\"Dojo\",\"Status\":0,\"62B91BD94558409B4F7352B5B96F3ED7\":{\"Status\":0,\"6CA2C43B46334BC06F73DEB5F2BFFEC1\":{\"Status\":0,\"CurrentAmount\":0,\"LastUpdateAmount\":0},\"3A7241AA43743647D3C1E39E8976E4F3\":{\"Status\":0,\"CurrentAmount\":0,\"LastUpdateAmount\":0}},\"816CBFD94D16EDA252BD1D8461209568\":{\"Status\":1},\"B152371947599B3C2D55BE9B91439C37\":{\"Status\":0,\"D3F19E2248AECEF5C5C3C8B9E2AC2C67\":{\"Status\":0,\"CurrentAmount\":0,\"LastUpdateAmount\":0},\"0407C2134FE0BEFE3EC791999632D2BC\":{\"Status\":0,\"CurrentAmount\":0,\"LastUpdateAmount\":0}},\"DFE54F884C6FC60688B6C494D79ADD29\":{\"Status\":0,\"9D1B0D754DBC896034F942AD625F9D93\":{\"Status\":0,\"CurrentAmount\":0,\"LastUpdateAmount\":0}}}";
        }
    }

    return JSON.stringify(CharacterData);
}

export async function CreateCharacterForUid(userId: string, characterName: string){
    let CharacterUUID = crypto.randomUUID();

    let CurrentDate = new Date();

    let FormattedCurrentDate = CurrentDate.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric"
    });

    let NewCharacter = await GetDb().insert(characters).values({
        characterId: CharacterUUID,
        userId: userId,
        name: characterName,
        createdDate: FormattedCurrentDate,
        lastModifiedDate: FormattedCurrentDate,
        updateVersion: 0,
        data: "{}"
    }).returning();

    return TransformDbCharacterToWireCharacter(NewCharacter[0]);
}

export async function UpdateCharacterForUid(CharacterId: string, UserId: string, CharacterDataToUpdateWith: string, UpdateVersion: number){
    const CurrentData = await GetCharacterWithUid(CharacterId, UserId);

    if(CurrentData == undefined){
        logger.warn(`Refusing to update unknown characterId ${CharacterId} for userId ${UserId}`);

        return false;
    }

    if(!Number.isFinite(Number(UpdateVersion))){
        logger.warn(`Refusing to update characterId ${CharacterId} for userId ${UserId} with non-numeric updateVersion ${UpdateVersion}`);

        return false;
    }

    // The client re-sends a save at the version it already holds when travel or
    // a retry overlaps an in-flight save, which used to be rejected as a
    // conflict and lost the write. Treat an equal version as an idempotent
    // re-send and accept it; only a strictly older version is a genuinely stale
    // write worth refusing. Every 1.12 character save comes from the player's
    // own client (caller=player in the save log; world servers never write
    // characters), so an equal-version save is that client's newer state.
    if(CurrentData.updateVersion > UpdateVersion){
        return false;
    }

    // An empty save never replaces a character that has data: that is a
    // wiped or forged payload, not progress.
    const Stored = await GetDb().query.characters.findFirst({
        columns: { data: true },
        where: and(eq(characters.characterId, CharacterId), eq(characters.userId, UserId))
    });
    if(IsEmptyCharacterData(CharacterDataToUpdateWith) && !IsEmptyCharacterData(Stored?.data)){
        logger.warn(`Refusing an empty save over characterId ${CharacterId} for userId ${UserId} at updateVersion ${UpdateVersion}`);

        return false;
    }

    CharacterDataToUpdateWith = ProcessTriggers(SKIP_FTUE ? NormalizeReturningPlayer(CharacterDataToUpdateWith) : CharacterDataToUpdateWith);

    await GetDb().update(characters).set({
        data: CharacterDataToUpdateWith,
        updateVersion: UpdateVersion
    }).where(and(and(eq(characters.userId, UserId), eq(characters.characterId, CharacterId)), lte(characters.updateVersion, UpdateVersion)));

    return true;
}

export async function GetCharacterWithUid(CharacterId: string, UserId: string){
    const Character = await GetDb().query.characters.findFirst({where: and(eq(characters.characterId, CharacterId), eq(characters.userId, UserId))});

    if(Character == undefined){
        return undefined;
    }

    return TransformDbCharacterToWireCharacter(Character);
}
