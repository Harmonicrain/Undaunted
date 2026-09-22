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
