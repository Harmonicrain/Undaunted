"use strict";

// Public hunting grounds are shared: a request for an island with a running
// public world that has room joins it. Private Hunt always gets its own world,
// and leaving (travel or closing the client) frees the slot.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const Harness = require("./harness");

let Deploy, Matchmaking, Party, Presence, Context;
const Live = new Map(); // port -> hunt id the fake deploy server is running
const Requests = [];
const FailNext = new Set();
let NextPort = 8800;

before(async () => {
    Deploy = http.createServer((req, res) => {
        let Body = "";
        req.on("data", (Chunk) => { Body += Chunk; });
        req.on("end", () => {
            const Request = JSON.parse(Body || "{}");
            Requests.push(Request);
            if (FailNext.delete(Request.HuntId)) {
                res.writeHead(503);
                res.end();
                return;
            }
            let Reply;
            if (Request.JoinPort !== undefined && Live.get(Request.JoinPort) === Request.HuntId) {
                Reply = { host: "127.0.0.1", port: Request.JoinPort, joined: true };
            } else {
                const Port = NextPort++;
                Live.set(Port, Request.HuntId);
                Reply = { host: "127.0.0.1", port: Port };
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(Reply));
        });
    });
    await new Promise((resolve) => Deploy.listen(0, "127.0.0.1", resolve));
    process.env.MATCHMAKING_MODE = "DEPLOYSERVER";
    process.env.DEPLOYSERVER_URL = `127.0.0.1:${Deploy.address().port}`;
    Context = Harness.CreateDisposableDatabase();
    Matchmaking = require("../dist/features/party/matchmaking");
    Party = require("../dist/features/party/party");
    Presence = require("../dist/realtime/PresenceService");
});

after(async () => { await new Promise((resolve) => Deploy.close(resolve)); Context.Db.$client.close(); Context.Cleanup(); });

const Id = (() => { let N = 0; return () => `UID-hg-${++N}`; })();

async function Hunt(PlayerId, HuntId, Options = {}) {
    assert.equal(await Matchmaking.HandlePlayerMatchmaking("SHARED", "", HuntId, PlayerId, { GameType: "HUNTING_GROUND", ...Options }), true);
    const Result = await Matchmaking.CheckAndUpdateQueueStatus(PlayerId);
    assert.equal(Result.Ready, true);
    return Result;
}

test("a public hunting ground request joins the running public world of that island", async () => {
    const A = await Hunt(Id(), "ShatteredIsles_IslandT1");
    assert.equal(Requests.at(-1).JoinPort, undefined);
    const B = await Hunt(Id(), "ShatteredIsles_IslandT1");
    assert.equal(Requests.at(-1).JoinPort, A.Port);
    assert.equal(B.Port, A.Port);
    // Another island is a different world.
    const C = await Hunt(Id(), "ShatteredIsles_IslandT2");
    assert.notEqual(C.Port, A.Port);
});

test("Private Hunt gets its own world and nobody is sent into it", async () => {
    const Public = await Hunt(Id(), "ShatteredIsles_IslandT3");
    const Private = await Hunt(Id(), "ShatteredIsles_IslandT3", { Private: true });
    assert.equal(Requests.at(-1).JoinPort, undefined);
    assert.notEqual(Private.Port, Public.Port);
    const Joiner = await Hunt(Id(), "ShatteredIsles_IslandT3");
    assert.equal(Joiner.Port, Public.Port);

    const Alone = await Hunt(Id(), "ShatteredIsles_IslandT4", { Private: true });
    const Next = await Hunt(Id(), "ShatteredIsles_IslandT4");
    assert.equal(Requests.at(-1).JoinPort, undefined);
    assert.notEqual(Next.Port, Alone.Port);
});

test("concurrent public cold starts share one world", async () => {
    const Start = Requests.length;
    const Results = await Promise.all(Array.from({ length: 4 }, () => Hunt(Id(), "ShatteredIsles_IslandT12")));
    assert.equal(new Set(Results.map(Result => Result.Port)).size, 1);
    assert.equal(Requests.slice(Start).filter(Request => Request.JoinPort === undefined).length, 1);
});

test("concurrent joiners cannot both take the last slot", async () => {
    const HuntId = "ShatteredIsles_IslandT13";
    const First = await Hunt(Id(), HuntId);
    for (let N = 0; N < 2; N++) await Hunt(Id(), HuntId);
    const Results = await Promise.all([Hunt(Id(), HuntId), Hunt(Id(), HuntId)]);
    assert.equal(Results.filter(Result => Result.Port === First.Port).length, 1);
    assert.equal(new Set(Results.map(Result => Result.Port)).size, 2);
});

test("a solo player requesting their current island keeps their world", async () => {
    const Player = Id();
    const First = await Hunt(Player, "ShatteredIsles_IslandT14");
    const Again = await Hunt(Player, "ShatteredIsles_IslandT14");
    assert.equal(Again.Port, First.Port);
    assert.equal(Requests.at(-1).JoinPort, First.Port);
});

test("a failed public allocation does not block the next request", async () => {
    const HuntId = "ShatteredIsles_IslandT15";
    const Player = Id();
    FailNext.add(HuntId);
    assert.equal(await Matchmaking.HandlePlayerMatchmaking("SHARED", "", HuntId, Player, { GameType: "HUNTING_GROUND" }), true);
    assert.equal((await Matchmaking.CheckAndUpdateQueueStatus(Player)).Failed, true);
    const Retry = await Hunt(Player, HuntId);
    assert.equal((await Hunt(Id(), HuntId)).Port, Retry.Port);
});

test("a full world is not joined, and a party joins only if all of it fits", async () => {
    const First = await Hunt(Id(), "ShatteredIsles_IslandT5");
    for (let N = 0; N < 3; N++) assert.equal((await Hunt(Id(), "ShatteredIsles_IslandT5")).Port, First.Port);
    const Fifth = await Hunt(Id(), "ShatteredIsles_IslandT5");
    assert.notEqual(Fifth.Port, First.Port);

    // Fifth's world has one player: a party of three fits, a fourth member would not.
    const [Leader, ...Members] = ["HgLead", "HgTwo", "HgThree"].map(Name => Harness.SeedAccount(Context, Name));
    Party.GetOrCreateParty(Leader.UserId, "test-build");
    for (const Member of Members) {
        Party.InviteToParty(Leader.UserId, Member.UserId, "test-build");
        Party.AcceptPartyInvite(Member.UserId, Party.GetInvitesForPlayer(Member.UserId)[0].inviteId);
    }
    const Trio = await Hunt(Leader.UserId, "ShatteredIsles_IslandT5");
    assert.equal(Trio.Port, Fifth.Port);
    assert.equal((await Matchmaking.CheckAndUpdateQueueStatus(Members[1].UserId)).Port, Fifth.Port);
    assert.notEqual((await Hunt(Id(), "ShatteredIsles_IslandT5")).Port, Fifth.Port);
});

test("asking again for the island you are on keeps your place in that world", async () => {
    const Players = [Id(), Id(), Id(), Id()];
    const World = await Hunt(Players[0], "ShatteredIsles_IslandT10");
    for (const Player of Players.slice(1)) await Hunt(Player, "ShatteredIsles_IslandT10");
    assert.equal((await Hunt(Players[1], "ShatteredIsles_IslandT10")).Port, World.Port);
    assert.notEqual((await Hunt(Id(), "ShatteredIsles_IslandT10")).Port, World.Port);
});

test("travelling to Ramsgate frees the slot", async () => {
    const Players = [Id(), Id(), Id(), Id()];
    const World = await Hunt(Players[0], "ShatteredIsles_IslandT6");
    for (const Player of Players.slice(1)) await Hunt(Player, "ShatteredIsles_IslandT6");
    assert.equal(await Matchmaking.HandlePlayerMatchmaking("CITY", "", "ShatteredIsles_ReturnToRamsgate", Players[2]), true);
    assert.equal((await Hunt(Id(), "ShatteredIsles_IslandT6")).Port, World.Port);
});

test("closing the client frees the slot once the player is offline", async () => {
    const Players = [Id(), Id(), Id(), Id()];
    const World = await Hunt(Players[0], "ShatteredIsles_IslandT7");
    for (const Player of Players.slice(1)) await Hunt(Player, "ShatteredIsles_IslandT7");
    await Presence.onResourceUnavailable(Players[3], undefined, 0);
    assert.equal((await Hunt(Id(), "ShatteredIsles_IslandT7")).Port, World.Port);
});

test("a world the deploy server no longer runs is replaced, and the new one is shared", async () => {
    const Gone = await Hunt(Id(), "ShatteredIsles_IslandT8");
    Live.delete(Gone.Port);
    const Second = await Hunt(Id(), "ShatteredIsles_IslandT8");
    assert.equal(Requests.at(-1).JoinPort, Gone.Port);
    assert.notEqual(Second.Port, Gone.Port);
    assert.equal((await Hunt(Id(), "ShatteredIsles_IslandT8")).Port, Second.Port);
});

test("leaving the only player's world means the next request starts a new one", async () => {
    const Player = Id();
    const World = await Hunt(Player, "ShatteredIsles_IslandT9");
    await Presence.onResourceUnavailable(Player, undefined, 0);
    const Next = await Hunt(Id(), "ShatteredIsles_IslandT9");
    assert.equal(Requests.at(-1).JoinPort, undefined);
    assert.notEqual(Next.Port, World.Port);
});

test("a private escalation or mission skips the queue for strangers", async () => {
    const Private = Id();
    assert.equal(await Matchmaking.HandlePlayerMatchmaking("ISLAND", "", "CR19_PlayerHunt_Escalation_TestPrivate", Private, { Private: true, GameType: "ESCALATION" }), true);
    assert.equal((await Matchmaking.CheckAndUpdateQueueStatus(Private)).Ready, true);
    const Public = Id();
    assert.equal(await Matchmaking.HandlePlayerMatchmaking("ISLAND", "", "CR19_PlayerHunt_Escalation_TestPublic", Public, { GameType: "ESCALATION" }), true);
    assert.equal((await Matchmaking.CheckAndUpdateQueueStatus(Public)).Ready, false);
});
