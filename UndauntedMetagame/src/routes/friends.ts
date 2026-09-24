import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { GetDb } from "../db";
import { friendblocks, friends, users } from "../db/schema";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { notifyFriendEntries, notifyFriendshipAccepted, isLocallyOnline } from "../realtime/PresenceService";

export const friendsRouter = Router();

function Owner(req: any){ return req.AuthData.userId as string; }
function Edge(tx: any, ownerId: string, friendId: string){
    return tx.select().from(friends).where(and(eq(friends.ownerId, ownerId), eq(friends.friendId, friendId))).get();
}
function Block(tx: any, ownerId: string, blockedId: string){
    return tx.select().from(friendblocks).where(and(eq(friendblocks.ownerId, ownerId), eq(friendblocks.blockedId, blockedId))).get();
}
function DeleteEdges(tx: any, a: string, b: string){
    tx.delete(friends).where(and(eq(friends.ownerId, a), eq(friends.friendId, b))).run();
    tx.delete(friends).where(and(eq(friends.ownerId, b), eq(friends.friendId, a))).run();
}
function PutEdge(tx: any, ownerId: string, friendId: string, status: string, direction: string, createdAt: string){
    tx.insert(friends).values({ ownerId, friendId, status, direction, createdAt }).onConflictDoUpdate({
        target: [friends.ownerId, friends.friendId], set: { status, direction, createdAt }
    }).run();
}

friendsRouter.get("/friends/api/public/friends/:accountId", HasUndauntedMetagameAuth, (req: any, res) => {
    const ownerId = Owner(req);
    if(req.params.accountId !== ownerId){ res.sendStatus(403); return; }
    const includePending = req.query.includePending === "true";
    const rows = GetDb().select().from(friends).where(eq(friends.ownerId, ownerId)).all();
    res.json(rows.filter((row) => row.status === "ACCEPTED" || includePending).map((row) => ({
        accountId: row.friendId, status: row.status, direction: row.direction,
        created: row.createdAt, favorite: false
    })));
});

friendsRouter.post("/friends/api/public/friends/:accountId/:friendId", HasUndauntedMetagameAuth, (req: any, res) => {
    const ownerId = Owner(req), friendId = req.params.friendId as string;
    if(req.params.accountId !== ownerId){ res.sendStatus(403); return; }
    if(!friendId || friendId === ownerId){ res.sendStatus(400); return; }
    const result = GetDb().transaction((tx) => {
        if(!tx.select().from(users).where(eq(users.userId, friendId)).get()) return { status: 404, accepted: false };
        if(Block(tx, ownerId, friendId) || Block(tx, friendId, ownerId)) return { status: 403, accepted: false };
        const current = Edge(tx, ownerId, friendId);
        if(current?.status === "ACCEPTED" || current?.direction === "OUTBOUND") return { status: 204, accepted: current?.status === "ACCEPTED" };
        const now = new Date().toISOString();
        if(current?.direction === "INBOUND"){
            PutEdge(tx, ownerId, friendId, "ACCEPTED", "OUTBOUND", current.createdAt);
            PutEdge(tx, friendId, ownerId, "ACCEPTED", "OUTBOUND", current.createdAt);
        } else {
            PutEdge(tx, ownerId, friendId, "PENDING", "OUTBOUND", now);
            PutEdge(tx, friendId, ownerId, "PENDING", "INBOUND", now);
        }
        return { status: 204, accepted: current?.direction === "INBOUND" };
    }, { behavior: "immediate" });
    if(result.status === 204) notifyFriendEntries(ownerId, friendId);
    if(result.accepted) notifyFriendshipAccepted(ownerId, friendId);
    res.sendStatus(result.status);
});

friendsRouter.get("/present/:accountId", HasUndauntedMetagameAuth, (req: any, res) => {
    res.json({ accountId: req.params.accountId, online: isLocallyOnline(req.params.accountId) });
});

friendsRouter.delete("/friends/api/public/friends/:accountId/:friendId", HasUndauntedMetagameAuth, (req: any, res) => {
    const ownerId = Owner(req), friendId = req.params.friendId as string;
    if(req.params.accountId !== ownerId){ res.sendStatus(403); return; }
    GetDb().transaction((tx) => DeleteEdges(tx, ownerId, friendId), { behavior: "immediate" });
    notifyFriendEntries(ownerId, friendId);
    res.sendStatus(204);
});

friendsRouter.get("/friends/api/public/blocklist/:accountId", HasUndauntedMetagameAuth, (req: any, res) => {
    const ownerId = Owner(req);
    if(req.params.accountId !== ownerId){ res.sendStatus(403); return; }
    const blocked = GetDb().select().from(friendblocks).where(eq(friendblocks.ownerId, ownerId)).all();
    const blockedIds = blocked.map((row) => row.blockedId);
    // 1.4.4 reads blocklistedUsers. 1.12.0 parses the newer BlockListDTO,
    // blockedUsers, and logs "Field blockedUsers was not found" without it.
    res.json({ blocklistedUsers: blockedIds, blockedUsers: blockedIds });
});

friendsRouter.post("/friends/api/public/blocklist/:accountId/:blockedId", HasUndauntedMetagameAuth, (req: any, res) => {
    const ownerId = Owner(req), blockedId = req.params.blockedId as string;
    if(req.params.accountId !== ownerId){ res.sendStatus(403); return; }
    if(!blockedId || blockedId === ownerId){ res.sendStatus(400); return; }
    const result = GetDb().transaction((tx) => {
        if(!tx.select().from(users).where(eq(users.userId, blockedId)).get()) return 404;
        DeleteEdges(tx, ownerId, blockedId);
        tx.insert(friendblocks).values({ ownerId, blockedId, createdAt: new Date().toISOString() })
            .onConflictDoNothing().run();
        return 204;
    }, { behavior: "immediate" });
    if(result === 204) notifyFriendEntries(ownerId, blockedId);
    res.sendStatus(result);
});

friendsRouter.delete("/friends/api/public/blocklist/:accountId/:blockedId", HasUndauntedMetagameAuth, (req: any, res) => {
    const ownerId = Owner(req);
    if(req.params.accountId !== ownerId){ res.sendStatus(403); return; }
    GetDb().delete(friendblocks).where(and(eq(friendblocks.ownerId, ownerId), eq(friendblocks.blockedId, req.params.blockedId))).run();
    res.sendStatus(204);
});

friendsRouter.get("/friends/api/public/list/:namespace/:accountId/recentPlayers", HasUndauntedMetagameAuth, (req: any, res) => {
    if(req.params.accountId !== Owner(req)){ res.sendStatus(403); return; }
    res.json([]);
});

friendsRouter.get("/friends/api/v1/:accountId/settings", HasUndauntedMetagameAuth, (req: any, res) => {
    if(req.params.accountId !== Owner(req)){ res.sendStatus(403); return; }
    res.json({ acceptInvites: "public", mutualPrivacy: "ALL" });
});
