import { Router } from "express";
import { logger } from "../logger";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { CreateCharacterForUid, GetCharactersForUid, GetCharacterWithUid, UpdateCharacterForUid } from "../controllers/character";
import express from "express";

export const characterRouter = Router();

// Diagnostics for lost character saves. More than one caller saves the same
// character blob, each counting updateVersion on its own, and a save that
// replaces newer data drops whatever the other caller wrote (quest SERIE_*
// state, flags). Record who saved which version and which top-level keys
// differ from the stored copy; quest keys also show their status digest.
function QuestDigest(Value: unknown){
    const Out: string[] = [];
    const Walk = (Node: any) => {
        if(Node == null || typeof Node !== "object") return;
        if("Status" in Node) Out.push("CurrentAmount" in Node ? `${Node.Status}:${Node.CurrentAmount}` : `${Node.Status}`);
        for(const Inner of Object.values(Node)) Walk(Inner);
    };
    try{ Walk(typeof Value === "string" ? JSON.parse(Value) : Value); } catch { return "?"; }
    return Out.join(",");
}
function DescribeSave(req: any, Stored: { data: string, updateVersion: number } | undefined, Incoming: unknown){
    const Caller = req.AuthData?.IsGameserver === true
        ? `gameserver ${req.headers["x-undaunted-request-id"] ?? "-"} ${String(req.headers["x-undaunted-world"] ?? "-").split("/").pop()}`
        : "player";
    let Changed: string[];
    try{
        const Before = JSON.parse(Stored?.data ?? "{}"), After = JSON.parse(String(Incoming));
        Changed = [...new Set([...Object.keys(Before), ...Object.keys(After)])]
            .filter((Key) => JSON.stringify(Before[Key]) !== JSON.stringify(After[Key]))
            .map((Key) => Key.startsWith("SERIE_") ? `${Key}(${QuestDigest(Before[Key])} -> ${QuestDigest(After[Key])})` : Key);
    } catch {
        Changed = ["<unparsable>"];
    }
    return `caller=${Caller} stored=v${Stored?.updateVersion ?? "-"} changed=[${Changed.slice(0, 24).join(" ")}]`;
}

characterRouter.get("/character", HasUndauntedMetagameAuth, async (req: any, res) => {
    const UserId = req.AuthData.userId;

    const CharactersForUid = await GetCharactersForUid(UserId);

    logger.info(`Retrieved ${CharactersForUid.length} characters for ${UserId}`);

    res.status(200);
    res.json(CharactersForUid);
});

characterRouter.put("/character", HasUndauntedMetagameAuth, async (req: any, res) => {
    const CharacterNameToCreate = req.body.name;

    logger.info(`Creating a character named ${CharacterNameToCreate} for user ${req.AuthData.userId}`);

    let NewCharacter = await CreateCharacterForUid(req.AuthData.userId, CharacterNameToCreate);

    res.status(200);
    res.json(NewCharacter);
})

characterRouter.post("/character", HasUndauntedMetagameAuth, async (req: any, res) => {
    const CharacterIdToUpdate = req.body.characterId;
    const UserId = req.AuthData.userId;
    const DataToUpdateWith = req.body.data;
    const UpdateVersion = req.body.updateVersion;

    const Stored = await GetCharacterWithUid(CharacterIdToUpdate, UserId);
    logger.info(`Updating characterId ${CharacterIdToUpdate} for userId ${UserId} with updateVersion ${UpdateVersion}; ${DescribeSave(req, Stored, DataToUpdateWith)}`);

    const DidSucceed = await UpdateCharacterForUid(CharacterIdToUpdate, UserId, DataToUpdateWith, UpdateVersion);

    if(!DidSucceed){
        logger.warn(`Failed to update characterId ${CharacterIdToUpdate} for userId ${UserId} due to conflict`);

        res.status(409);
        res.send();
        return;
    }

    const UpdatedCharacter = await GetCharacterWithUid(CharacterIdToUpdate, UserId);

    res.status(200);
    res.json(UpdatedCharacter);
});