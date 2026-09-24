"use strict";

// World allocation failures must not be reported as Ready. Previously a failed
// deployserver call still marked players Ready with host "" and port 0, so the
// client travelled nowhere and the failure looked like a progression bug.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const Harness = require("./harness");

let Deploy, DeployReply, Matchmaking, Party, Context;

before(async () => {
    Deploy = http.createServer((req, res) => {
        let Body = "";
        req.on("data", (Chunk) => { Body += Chunk; });
        req.on("end", () => {
            const Reply = DeployReply(JSON.parse(Body || "{}"));
            if (Reply.drop) { req.socket.destroy(); return; }
            res.writeHead(Reply.status, { "content-type": "application/json" });
            res.end(typeof Reply.body === "string" ? Reply.body : JSON.stringify(Reply.body));
        });
    });
    await new Promise((resolve) => Deploy.listen(0, "127.0.0.1", resolve));
    process.env.MATCHMAKING_MODE = "DEPLOYSERVER";
    process.env.DEPLOYSERVER_URL = `127.0.0.1:${Deploy.address().port}`;
    Context = Harness.CreateDisposableDatabase();
    Matchmaking = require("../dist/controllers/matchmaking");
    Party = require("../dist/controllers/party");
});

after(async () => { await new Promise((resolve) => Deploy.close(resolve)); Context.Db.$client.close(); Context.Cleanup(); });

const Player = (() => { let N = 0; return () => `UID-mm-${++N}`; })();

test("a successful allocation is Ready with the returned address", async () => {
    DeployReply = () => ({ status: 200, body: { host: "127.0.0.1", port: 8790 } });
    const Id = Player();
    assert.equal(await Matchmaking.HandlePlayerMatchmaking("ISLAND", "", "Ramsgate_Hub", Id), true);
    const Result = await Matchmaking.CheckAndUpdateQueueStatus(Id);
    assert.equal(Result.Ready, true);
    assert.equal(Result.Failed, false);
    assert.equal(Result.Host, "127.0.0.1");
    assert.equal(Result.Port, 8790);
});

for (const [Name, Reply] of [
    ["an error status", () => ({ status: 500, body: {} })],
    ["a 200 with no host", () => ({ status: 200, body: { host: "", port: 0 } })],
    ["a 200 with a bad port", () => ({ status: 200, body: { host: "127.0.0.1", port: "8790" } })],
    ["a 200 that is not JSON", () => ({ status: 200, body: "not json" })]
]) {
    test(`${Name} from the deployserver is FAILED, never Ready`, async () => {
        DeployReply = Reply;
        const Id = Player();
        await Matchmaking.HandlePlayerMatchmaking("ISLAND", "", "Ramsgate_Hub", Id);
        const Result = await Matchmaking.CheckAndUpdateQueueStatus(Id);
        assert.equal(Result.Ready, false);
        assert.equal(Result.Failed, true);
        assert.ok(Result.FailureReason);
        assert.equal(Result.Port, 0);
    });
}

test("a queued hunt whose allocation fails marks every queued player FAILED", async () => {
    DeployReply = () => ({ status: 503, body: {} });
    const Ids = [Player(), Player(), Player(), Player()];
    for (const Id of Ids) await Matchmaking.HandlePlayerMatchmaking("ISLAND", "", "Escalation_Test_Hunt", Id);
    for (const Id of Ids) {
        const Result = await Matchmaking.CheckAndUpdateQueueStatus(Id);
        assert.equal(Result.Failed, true, Id);
        assert.equal(Result.Ready, false, Id);
    }
});

test("a deployserver that drops the connection fails the candidate instead of throwing", async () => {
    DeployReply = () => ({ drop: true });
    const Id = Player();
    assert.equal(await Matchmaking.HandlePlayerMatchmaking("ISLAND", "", "Ramsgate_Hub", Id), true);
    const Result = await Matchmaking.CheckAndUpdateQueueStatus(Id);
    assert.equal(Result.Ready, false);
    assert.equal(Result.Failed, true);
    assert.match(Result.FailureReason, /unreachable/);
});

test("party leader allocates one world and one candidate for both members", async () => {
    const John = Harness.SeedAccount(Context, "PartyJohn");
    const Manda = Harness.SeedAccount(Context, "PartyManda");
    Party.GetOrCreateParty(John.UserId, "test-build");
    Party.InviteToParty(John.UserId, Manda.UserId, "test-build");
    const Invite = Party.GetInvitesForPlayer(Manda.UserId)[0];
    Party.AcceptPartyInvite(Manda.UserId, Invite.inviteId);
    let allocations = 0;
    DeployReply = body => {
        allocations++;
        assert.deepEqual(body.ExpectedPlayers, [John.UserId, Manda.UserId]);
        return { status: 200, body: { host: "127.0.0.1", port: 8790 } };
    };
    assert.equal(await Matchmaking.HandlePlayerMatchmaking("ISLAND", "", "Ramsgate_Hub", John.UserId), true);
    const a = await Matchmaking.CheckAndUpdateQueueStatus(John.UserId);
    const b = await Matchmaking.CheckAndUpdateQueueStatus(Manda.UserId);
    assert.equal(allocations, 1);
    assert.equal(a.CandidateId, b.CandidateId);
    assert.equal(a.Host, b.Host);
    assert.equal(a.Port, b.Port);
});

function PartyOf(...Names) {
    const [Leader, ...Rest] = Names.map(Name => Harness.SeedAccount(Context, Name));
    Party.GetOrCreateParty(Leader.UserId, "test-build");
    for (const Member of Rest) {
        Party.InviteToParty(Leader.UserId, Member.UserId, "test-build");
        Party.AcceptPartyInvite(Member.UserId, Party.GetInvitesForPlayer(Member.UserId)[0].inviteId);
    }
    return [Leader, ...Rest];
}
// What DELETE /party/member does for the player who leaves.
function Leave(Player) {
    for (const Member of Party.GetPartyForPlayer(Player.UserId)?.members ?? [Player.UserId]) Matchmaking.CancelPendingCandidateForPlayer(Member);
    Party.LeaveParty(Player.UserId);
}

test("someone leaving the party mid-hunt leaves the others' running hunt alone", async () => {
    DeployReply = () => ({ status: 200, body: { host: "127.0.0.1", port: 8787 } });
    const [John, Manda, Todd] = PartyOf("LeaveJohn", "LeaveManda", "LeaveTodd");
    await Matchmaking.HandlePlayerMatchmaking("ISLAND", "", "Ramsgate_Hub", John.UserId);
    Leave(Todd);
    // John and Manda are still in that hunt: their status still answers.
    for (const Player of [John, Manda]) {
        const Result = await Matchmaking.CheckAndUpdateQueueStatus(Player.UserId);
        assert.ok(Result, Player.UserId);
        assert.equal(Result.Ready, true);
        assert.equal(Result.Port, 8787);
    }
    // Returning to Ramsgate afterwards replaces the hunt with the city.
    DeployReply = () => ({ status: 200, body: { host: "127.0.0.1", port: 8789 } });
    Leave(Manda);
    await Matchmaking.HandlePlayerMatchmaking("CITY", "", "", John.UserId);
    const Back = await Matchmaking.CheckAndUpdateQueueStatus(John.UserId);
    assert.equal(Back.Port, 8789);
    assert.equal(Back.GameMode, "CITY");
});

test("a party change still cancels a queue that has not found a world", async () => {
    DeployReply = () => ({ status: 200, body: { host: "127.0.0.1", port: 8786 } });
    const [Leader, Member] = PartyOf("QueueLeader", "QueueMember");
    await Matchmaking.HandlePlayerMatchmaking("ISLAND", "", "Escalation_Leave_Hunt", Leader.UserId);
    assert.equal((await Matchmaking.CheckAndUpdateQueueStatus(Member.UserId)).Ready, false);
    Leave(Member);
    assert.equal(await Matchmaking.CheckAndUpdateQueueStatus(Leader.UserId), undefined);
    assert.equal(await Matchmaking.CheckAndUpdateQueueStatus(Member.UserId), undefined);
});

test("the candidate keeps the mode the client asked for", async () => {
    DeployReply = () => ({ status: 200, body: { host: "127.0.0.1", port: 8789 } });
    const [City, Island] = [Player(), Player()];
    await Matchmaking.HandlePlayerMatchmaking("CITY", "", "", City);
    await Matchmaking.HandlePlayerMatchmaking("ISLAND", "", "Ramsgate_Hub", Island);
    assert.equal((await Matchmaking.CheckAndUpdateQueueStatus(City)).GameMode, "CITY");
    assert.equal((await Matchmaking.CheckAndUpdateQueueStatus(Island)).GameMode, "ISLAND");
});

test("two players who travel to the same world separately share its game session, and so its chat room", async () => {
    DeployReply = () => ({ status: 200, body: { host: "192.168.1.10", port: 8789 } });
    const [A, B] = [Player(), Player()];
    await Matchmaking.HandlePlayerMatchmaking("CITY", "", "", A);
    await Matchmaking.HandlePlayerMatchmaking("CITY", "", "", B);
    const [RA, RB] = [await Matchmaking.CheckAndUpdateQueueStatus(A), await Matchmaking.CheckAndUpdateQueueStatus(B)];
    // Each keeps its own matchmaking candidate...
    assert.notEqual(RA.CandidateId, RB.CandidateId);
    // ...but the world's session id is the same for both, and a UUID.
    const [SA, SB] = [Matchmaking.WorldSessionId(RA.Host, RA.Port), Matchmaking.WorldSessionId(RB.Host, RB.Port)];
    assert.equal(SA, SB);
    assert.match(SA, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Another world has another session.
    assert.notEqual(Matchmaking.WorldSessionId("192.168.1.10", 8788), SA);
});
