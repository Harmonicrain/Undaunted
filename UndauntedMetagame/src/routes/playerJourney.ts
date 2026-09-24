// Player Journey (Slayer's Path) for the 1.12.0 client.
//
//   GET  /pjm            client: its own node map
//   GET  /pjm/{account}  gameserver: a player's node map
//   POST /pjm/{account}  gameserver: save the whole map ({nodes, update_version})
//
// A failed read stops the client with "Error reading your character's Player
// Journey data". Envelope and the empty baseline follow Mystic Paradox's
// ParadoxBackend (pranav158/Mystic-Paradox@355934c src/routes/progression.ts);
// see NOTICE.md. The full node graph (definitions and rewards) is game data
// that is not generated here yet, so a new player starts from an empty map.
import { Router } from "express";
import { eq } from "drizzle-orm";
import { GetDb } from "../db";
import { playerjourney } from "../db/schema";
import { logger } from "../logger";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";

export const playerJourneyRouter = Router();

// The gameserver asks for "INVALID" when no player is attached.
const NO_PLAYER = "INVALID";

function Read(UserId: string){
    const Row = GetDb().select().from(playerjourney).where(eq(playerjourney.userId, UserId)).get();
    if(Row == undefined) return { nodes: {}, update_version: 1 };
    return { nodes: JSON.parse(Row.nodes), update_version: Row.updateVersion };
}
function Send(res: any, Payload: unknown){
    res.json({ code: null, message: "OK", payload: Payload });
}

playerJourneyRouter.get("/pjm", HasUndauntedMetagameAuth, (req: any, res) => {
    const UserId = req.AuthData?.userId;
    Send(res, typeof UserId === "string" ? Read(UserId) : { nodes: {}, update_version: 1 });
});

playerJourneyRouter.get("/pjm/:userId", HasUndauntedMetagameAuth, (req: any, res) => {
    const UserId = req.params.userId;
    if(req.AuthData?.IsGameserver !== true && req.AuthData?.userId !== UserId){ res.sendStatus(403); return; }
    Send(res, UserId === NO_PLAYER ? { nodes: {}, update_version: 1 } : Read(UserId));
});

playerJourneyRouter.post("/pjm/:userId", HasUndauntedMetagameAuth, (req: any, res) => {
    const UserId = req.params.userId;
    if(req.AuthData?.IsGameserver !== true){ res.sendStatus(403); return; }
    const Nodes = req.body?.nodes;
    const Version = req.body?.update_version;
    if(Nodes == null || typeof Nodes !== "object" || Array.isArray(Nodes) || !Number.isSafeInteger(Version ?? 1)){
        res.status(400).json({ code: "400", message: "Invalid player journey" });
        return;
    }
    if(UserId === NO_PLAYER){ Send(res, { nodes: {}, update_version: Version ?? 1 }); return; }
    const Values = { userId: UserId, nodes: JSON.stringify(Nodes), updateVersion: Version ?? 1, updatedAt: Date.now() };
    GetDb().insert(playerjourney).values(Values).onConflictDoUpdate({ target: playerjourney.userId, set: Values }).run();
    logger.info(`Player journey saved for ${UserId}: ${Object.keys(Nodes).length} node(s), v${Values.updateVersion}`);
    Send(res, { nodes: Nodes, update_version: Values.updateVersion });
});
