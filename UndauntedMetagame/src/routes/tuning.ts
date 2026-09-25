import { Router } from "express";
import { logger } from "../logger";
import { ActiveFeatureFlags, SeasonalEventSchedule } from "../controllers/seasonalEvents";

export const tuningRouter = Router();

// The seasonal events that are running: see controllers/seasonalEvents.
tuningRouter.get("/game_tuning/seasonal_event_schedule", (req: any, res) => {
    logger.debug("Seasonal event schedule requested");

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: SeasonalEventSchedule()
    });
})

// The client feature flags the runtime DLL forces on (both the client and the
// gameserver ask, once, when the game first checks a flag). Not per player.
tuningRouter.get("/undaunted/feature_flags", (req: any, res) => {
    const Enabled = ActiveFeatureFlags();
    logger.info(`Feature flags requested: ${Enabled.length > 0 ? Enabled.join(", ") : "none forced"}`);

    res.status(200);
    res.json({ code: null, message: "OK", payload: { enabled: Enabled } });
});

tuningRouter.get("/game_tuning/huntpass_xp_config", (req: any, res) => {
    logger.info("Huntpass XP Config (stubbed)");

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: {
            EventConfigs: [],
            GlobalConfig: {
                DifficultyBias: 1.000000000000000,
                GlobalMultiplier: 1.000000000000000,
                MaxXPAwarded: 200
            }
        }
    });
});