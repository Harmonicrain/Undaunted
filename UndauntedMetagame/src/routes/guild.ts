import { Router } from "express";
import { logger } from "../logger";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";

export const guildRouter = Router();

guildRouter.get("/guild/invite/player", HasUndauntedMetagameAuth, (_req: any, res) => {
    logger.info("Guild invites (stubbed)");

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: {
            invites: []
        }
    });
});

guildRouter.get("/guild", HasUndauntedMetagameAuth, (_req: any, res) => {
    logger.info("Current guild (stubbed)");

    res.status(204);
    res.send();
});