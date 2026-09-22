import { Router } from "express";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { GetAllLoadoutsForUserIdAndCharacterId, GetPersistentLoadoutForUserIdAndCharacterId, MAX_LOADOUT_SLOTS, SetLoadoutDataForUserIdAndCharacterId, UnlockAdditionalCharacterSlots } from "../controllers/loadout";
import { logger } from "../logger";

export const loadoutRouter = Router();

// Shared response body for every loadout route. num_character_slots must
// reflect the number of slots actually stored: answering an unlock request
// with fewer slots than the caller asked for makes the gameserver retry the
// unlock in a tight loop.
function BuildLoadoutPayload(Loadouts: any[], Persistent: any){
    return {
        code: null,
        message: "OK",
        payload: {
            loadouts: Loadouts,
            persistent: Persistent,
            num_account_slots: 1, // TODO: Account-wide slots have no storage yet. Nothing has requested an unlock for them so far.
            max_account_slots: 1,
            num_character_slots: Loadouts.length,
            max_character_slots: MAX_LOADOUT_SLOTS,
            active_index: 0, // TODO: Make this support multi-loadouts
            needs_migration: false
        }
    };
}

loadoutRouter.get("/loadout/:userId/:characterId/all", HasUndauntedMetagameAuth, async (req: any, res) => {
    const RequestorAccountId = req.AuthData.IsGameserver ? req.params.userId : req.AuthData.userId;
    const CharacterId = req.params.characterId;

    const Loadouts: any[] = await GetAllLoadoutsForUserIdAndCharacterId(RequestorAccountId, CharacterId);
    const Persistent: any = await GetPersistentLoadoutForUserIdAndCharacterId(RequestorAccountId, CharacterId); // TODO: WARN: Ordering of this and the GetAllLoadoutsForUserIdAndCharacterId MUST NOT CHANGE until create-on-nonexistent is added in the loadout controller

    logger.info(`Fetched ${Loadouts.length} loadout(s) for userId ${RequestorAccountId} and characterId ${CharacterId}`);

    res.status(200);
    res.json(BuildLoadoutPayload(Loadouts, Persistent));
});

// The gameserver asks for additional character loadout slots during travel.
// Add that many slots and report the resulting count back, otherwise the
// request is never satisfied and it is re-sent in a tight loop.
loadoutRouter.post("/loadout/:userId/:characterId/unlock/:numSlots", HasUndauntedMetagameAuth, async (req: any, res) => {
    const RequestorAccountId = req.AuthData.IsGameserver ? req.params.userId : req.AuthData.userId;
    const CharacterId = req.params.characterId;

    const Loadouts: any[] = await UnlockAdditionalCharacterSlots(RequestorAccountId, CharacterId, req.params.numSlots);
    const Persistent: any = await GetPersistentLoadoutForUserIdAndCharacterId(RequestorAccountId, CharacterId);

    logger.info(`Character loadout slots now ${Loadouts.length} (requested ${req.params.numSlots}) for userId ${RequestorAccountId} and characterId ${CharacterId}`);

    res.status(200).json(BuildLoadoutPayload(Loadouts, Persistent));
});

loadoutRouter.post("/loadout/:userId/:characterId/:index", HasUndauntedMetagameAuth, async (req: any, res) => {
    const RequestorAccountId = req.AuthData.IsGameserver ? req.params.userId : req.AuthData.userId;
    const CharacterId = req.params.characterId;
    const Data = req.body.data;
    const Index = req.params.index;

    const Success = await SetLoadoutDataForUserIdAndCharacterId(RequestorAccountId, CharacterId, Index, Data);

    if(Success){
        logger.info(`Successfully updated loadout index ${Index} for userId ${RequestorAccountId} and characterId ${CharacterId}`);
        // TODO: RE success shape, below is a complete guess

        const Loadouts: any[] = await GetAllLoadoutsForUserIdAndCharacterId(RequestorAccountId, CharacterId);
        const Persistent: any = await GetPersistentLoadoutForUserIdAndCharacterId(RequestorAccountId, CharacterId); // TODO: WARN: Ordering of this and the GetAllLoadoutsForUserIdAndCharacterId MUST NOT CHANGE until create-on-nonexistent is added in the loadout controller

        logger.info(`Fetched ${Loadouts.length} loadout(s) for userId ${RequestorAccountId} and characterId ${CharacterId}`);

        res.status(200);
        res.json(BuildLoadoutPayload(Loadouts, Persistent));
    }
    else{
        logger.error(`Failed to update loadout index ${Index} for userId ${RequestorAccountId} and characterId ${CharacterId}`);

        res.status(400);
        res.send();
    }
});
