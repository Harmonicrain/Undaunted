import { Router } from "express";

import { HandleMatchmakingRequest } from "../controllers/matchmaker";
import express from "express";

export const matchmakingRouter = Router();

matchmakingRouter.post("/handle-matchmaking-for-player", express.json(), async (req, res) => {
    const GameMode = req.body.GameMode;
    const GameArgs = req.body.GameArgs;
    const HuntId = req.body.HuntId;
    const ExpectedPlayers = req.body.ExpectedPlayers;
    const JoinPort = req.body.JoinPort;

    const MatchmakingResult = await HandleMatchmakingRequest(GameMode, GameArgs, HuntId, ExpectedPlayers, JoinPort);

    res.status(200);
    res.json(MatchmakingResult);
});