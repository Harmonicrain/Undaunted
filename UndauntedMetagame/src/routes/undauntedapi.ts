import { Router } from "express";
import { DeleteInviteCode, GetAllUserIds, GetInviteCodes, GetRecentPlayerData, IsRegistrationMode, RegisterInviteCode, RegisterUser, REGISTRATION_MODE, SetRegistrationMode } from "../controllers/undauntedapi";
import { HasUndauntedUserApiKey } from "../middleware/HasUndauntedUserApiKey";
import { HasUndauntedAdminApiKey } from "../middleware/HasUndauntedAdminApiKey";
import { SignMetagameJWTForUid } from "../controllers/auth";
import { LauncherAuthLimit } from "../middleware/LauncherAuthLimit";

export const undauntedApiRouter = Router();

undauntedApiRouter.get("/RegistrationStatus", (_req, res) => {
    res.status(200);
    res.json({
        RegistrationMode: REGISTRATION_MODE
    });
});

undauntedApiRouter.post("/RegistrationStatus", HasUndauntedAdminApiKey, (req, res) => {
    const NewRegistrationStatus = req.body.RegistrationStatus;

    if(!SetRegistrationMode(NewRegistrationStatus)){
        res.status(400);
        res.send();
        return;
    }

    res.status(200);
    res.send();
});

undauntedApiRouter.get("/InviteCodes", HasUndauntedAdminApiKey, async (_req, res) => {
    const InviteCodes = await GetInviteCodes();

    res.status(200);
    res.json({
        InviteCodes: InviteCodes
    });
});

undauntedApiRouter.post("/GenerateJWTForUserId", HasUndauntedAdminApiKey, async (req, res) => {
    const UserId = req.body.UserId;

    const JWT = await SignMetagameJWTForUid(UserId);

    res.status(200);
    res.send({
        JWT: JWT
    });
});

undauntedApiRouter.get("/GetAllUsers", HasUndauntedAdminApiKey, async (_req, res) => {
    const AllUsers = await GetAllUserIds();

    res.status(200);
    res.send({
        Users: AllUsers
    });
})

undauntedApiRouter.post("/RegisterInviteCode", HasUndauntedAdminApiKey, async (req, res) => {    
    const NewInviteCode = req.body.NewInviteCode;
    const Uses = req.body.Uses;
    const InfiniteUses = !!req.body.InfiniteUses;

    if(!await RegisterInviteCode(NewInviteCode, Uses, InfiniteUses)){
        res.status(400);
        res.send();
        return;
    }

    res.status(200);
    res.send();
});

undauntedApiRouter.delete("/InviteCode/:inviteCodeToDelete", HasUndauntedAdminApiKey, async (req, res) => {
    const InviteCodeToDelete = req.params.inviteCodeToDelete as string;

    await DeleteInviteCode(InviteCodeToDelete);

    res.status(200);
    res.send();
});

undauntedApiRouter.post("/Register", LauncherAuthLimit, async (req, res) => {
    if(!IsRegistrationMode(REGISTRATION_MODE)){
        res.status(500);
        res.send();
        return;
    }

    if(REGISTRATION_MODE === "NONE"){
        res.status(400);
        res.send();
        return;
    }

    const Username = req.body.Username;
    if(typeof Username !== "string" || !/^[A-Za-z0-9_-]{3,16}$/.test(Username.trim())){
        res.status(400);
        res.send();
        return;
    }

    if(REGISTRATION_MODE === "INVITECODE"){
        const InviteCode = req.body.InviteCode;

        const UUK = typeof InviteCode === "string" && InviteCode.length <= 128
            ? await RegisterUser(Username, InviteCode) : undefined;
        if(UUK){

            res.status(200);
            res.json({
                UUK: UUK
            });
        }
        else{
            res.status(401);
            res.send();
        }
    }
    else if(REGISTRATION_MODE === "OPEN"){
        const UUK = await RegisterUser(Username);
        if(!UUK){ res.status(409).json({ message: "That username is already taken." }); return; }

        res.status(200);
        res.json({
            UUK: UUK
        });
    }
});

undauntedApiRouter.get("/GetUserInfo", HasUndauntedUserApiKey, async (req: any, res) => {
    res.status(200);
    res.json(req.UndauntedUserInfo);
});


undauntedApiRouter.get("/PrivateOnlineStats", HasUndauntedAdminApiKey, async (_req, res) => {
    const PlayerData = await GetRecentPlayerData();

    res.status(200);
    res.json(PlayerData);
});

undauntedApiRouter.get("/PublicOnlineStats", HasUndauntedUserApiKey, async (_req, res) => {
    const PlayerData = await GetRecentPlayerData();

    res.status(200);
    res.json({
        NumActivePlayers: PlayerData.length
    });
});
