"use strict";

// The linked-slayer heartbeat status poll must carry the same invites and
// links as the dedicated endpoints; an empty status made the client drop and
// re-add its invites on every heartbeat.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Harness = require("./harness");

let Context, Server, Base, Sign;

before(async () => {
    const Keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.AUTH_SIGNING_PRIVKEY_B64 = Buffer.from(Keys.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
    process.env.AUTH_SIGNING_PUBKEY_B64 = Buffer.from(Keys.publicKey.export({ type: "spki", format: "pem" })).toString("base64");
    Context = Harness.CreateDisposableDatabase();
    Sign = require("../dist/controllers/auth").SignMetagameJWTForUid;
    const App = require("express")();
    App.use(require("express").json());
    App.use(require("../dist/routes/friends").friendsRouter);
    App.use(require("../dist/routes/slayerLinks").slayerLinksRouter);
    Server = await new Promise(resolve => { const S = App.listen(0, "127.0.0.1", () => resolve(S)); });
    Base = `http://127.0.0.1:${Server.address().port}`;
});
after(async () => { await new Promise(resolve => Server.close(resolve)); Context.Db.$client.close(); Context.Cleanup(); });

async function Call(Account, Path, Method = "GET", Body) {
    const Response = await fetch(Base + Path, { method: Method, headers: { authorization: `bearer ${Sign(Account.UserId)}`, "content-type": "application/json" },
        ...(Body === undefined ? {} : { body: JSON.stringify(Body) }) });
    return { status: Response.status, json: await Response.json().catch(() => undefined) };
}

test("the heartbeat status carries the same invites and links as /invites and /links", async () => {
    const John = Harness.SeedAccount(Context, "StatusJohn"), Manda = Harness.SeedAccount(Context, "StatusManda"), Todd = Harness.SeedAccount(Context, "StatusTodd");
    for (const [A, B] of [[John, Manda], [Manda, John], [John, Todd], [Todd, John]]) {
        await Call(A, `/friends/api/public/friends/${A.UserId}/${B.UserId}`, "POST");
    }
    // Pending invite Manda -> John.
    assert.equal((await Call(Manda, "/slayerlink/invite", "PUT", { account_id: John.UserId, slot: 1 })).status, 200);
    let Status = (await Call(John, "/slayerlink/status_good")).json.payload;
    assert.deepEqual(Status.config, { link_duration_hours: 168, invite_expiry_hours: 24 });
    assert.equal(Status.link_duration_hours, 168);
    assert.deepEqual(Status.invites, (await Call(John, "/slayerlink/invites")).json.payload.invites);
    assert.equal(Status.invites.length, 1);
    assert.equal(Status.invites[0].account_id, Manda.UserId);
    assert.deepEqual(Status.links, []);
    // Repeated heartbeats report the same invite, never more.
    for (let I = 0; I < 3; I++) assert.equal((await Call(John, "/slayerlink/status_good")).json.payload.invites.length, 1);
    // Accept: the link appears with the partner as linked_account_id.
    assert.equal((await Call(John, "/slayerlink/invite", "POST", { account_id: Manda.UserId, action: "accept", slot: 1 })).status, 200);
    Status = (await Call(John, "/slayerlink/status_good")).json.payload;
    const Links = (await Call(John, "/slayerlink/links")).json.payload.links;
    assert.equal(Status.links.length, 1);
    assert.equal(Status.links[0].linked_account_id, Manda.UserId);
    assert.equal(Status.links[0].account_id, undefined);
    const { account_id, ...Rest } = Links[0];
    assert.equal(account_id, Manda.UserId);
    assert.deepEqual({ ...Status.links[0], linked_account_id: undefined }, { ...Rest, linked_account_id: undefined });
    assert.deepEqual(Status.invites, (await Call(John, "/slayerlink/invites")).json.payload.invites);
});
