"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Harness = require("./harness");

let db, context, server, base, sign;

before(async () => {
    const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.AUTH_SIGNING_PRIVKEY_B64 = Buffer.from(keys.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
    process.env.AUTH_SIGNING_PUBKEY_B64 = Buffer.from(keys.publicKey.export({ type: "spki", format: "pem" })).toString("base64");
    context = Harness.CreateDisposableDatabase();
    db = context.Db;
    sign = require("../dist/controllers/auth").SignMetagameJWTForUid;
    const app = require("express")();
    app.use(require("express").json());
    app.use(require("../dist/routes/friends").friendsRouter);
    app.use(require("../dist/routes/slayerLinks").slayerLinksRouter);
    app.use(require("../dist/routes/party").partyRouter);
    app.use(require("../dist/routes/eos").eosRouter);
    app.use(require("../dist/routes/login").loginRouter);
    server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); db.$client.close(); context.Cleanup(); });

function request(account, path, method = "GET", body) {
    return fetch(base + path, { method, headers: { authorization: `bearer ${sign(account.UserId)}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

test("friend invitation, acceptance, removal and block survive persisted reads", async () => {
    const john = Harness.SeedAccount(context, "John"), manda = Harness.SeedAccount(context, "Manda");
    const friends = account => `/friends/api/public/friends/${account.UserId}`;
    assert.equal((await request(john, `${friends(john)}/${manda.UserId}`, "POST")).status, 204);
    let inbound = await (await request(manda, `${friends(manda)}?includePending=true`)).json();
    assert.equal(inbound[0].direction, "INBOUND");
    assert.equal(inbound[0].status, "PENDING");
    assert.deepEqual(await (await request(manda, friends(manda))).json(), []);
    assert.equal((await request(manda, `${friends(manda)}/${john.UserId}`, "POST")).status, 204);
    assert.equal((await (await request(john, friends(john))).json())[0].status, "ACCEPTED");
    assert.equal((await (await request(manda, friends(manda))).json())[0].status, "ACCEPTED");
    assert.equal((await request(manda, `${friends(manda)}/${john.UserId}`, "POST")).status, 204);
    assert.equal(db.select().from(context.Schema.friends).all().length, 2);
    assert.equal((await request(john, `${friends(john)}/${manda.UserId}`, "DELETE")).status, 204);
    assert.deepEqual(await (await request(manda, friends(manda))).json(), []);
    assert.equal((await request(john, `/friends/api/public/blocklist/${john.UserId}/${manda.UserId}`, "POST")).status, 204);
    assert.deepEqual((await (await request(john, `/friends/api/public/blocklist/${john.UserId}`)).json()).blocklistedUsers, [manda.UserId]);
    assert.equal((await request(manda, `${friends(manda)}/${john.UserId}`, "POST")).status, 403);
    assert.equal((await request(john, `/friends/api/public/blocklist/${john.UserId}/${manda.UserId}`, "DELETE")).status, 204);
    assert.equal((await request(manda, `${friends(manda)}/${john.UserId}`, "POST")).status, 204);
    assert.equal((await request(john, `${friends(manda)}/${manda.UserId}`, "POST")).status, 403);
});

test("account lookup and OAuth verification use the signed local identity", async () => {
    const john = Harness.SeedAccount(context, "LookupJohn"), manda = Harness.SeedAccount(context, "LookupManda");
    const named = await (await request(john, "/account/api/public/account/displayName/lookupmanda")).json();
    assert.equal(named.id, manda.UserId);
    const byId = await (await request(john, `/account/api/public/account/${manda.UserId}`)).json();
    assert.equal(byId.displayName, "LookupManda");
    const verified = await (await request(john, "/account/api/oauth/verify")).json();
    assert.equal(verified.account_id, john.UserId);
    assert.equal((await fetch(base + "/account/api/oauth/verify")).status, 401);
    const mapping = await (await request(john, "/account/mapping", "POST",
        { srcAccountType: "epic", ids: [manda.UserId] })).json();
    assert.deepEqual(mapping, { accountMappings: {
        [manda.UserId]: { accountId: manda.UserId, accountType: "Phoenix" }
    }});
    const publicInfo = await (await request(john, "/accountinfo/public", "POST", { accountId: manda.UserId })).json();
    assert.equal(publicInfo.accountId, manda.UserId);
    assert.equal(publicInfo.linkedAccounts[0].accountId, manda.UserId);
});

test("accepted Slayer Link reserves a slot for both friends, persists, and refuses outsiders", async () => {
    const john = Harness.SeedAccount(context, "LinkJohn");
    const manda = Harness.SeedAccount(context, "LinkManda");
    const todd = Harness.SeedAccount(context, "LinkTodd");
    assert.equal((await request(john, "/slayerlink/invite", "PUT", { account_id: manda.UserId, slot: 0 })).status, 403);
    await request(john, `/friends/api/public/friends/${john.UserId}/${manda.UserId}`, "POST");
    await request(manda, `/friends/api/public/friends/${manda.UserId}/${john.UserId}`, "POST");
    const availability = await request(john, "/slayerlink/availability", "POST", { account_ids: [manda.UserId] });
    assert.equal(availability.status, 200);
    assert.deepEqual((await availability.json()).payload.availability,
        [{ account_id: manda.UserId, available: true }]);
    const response = await request(john, "/slayerlink/invite", "PUT", { account_id: manda.UserId, slot: 0 });
    assert.equal(response.status, 200);
    const id = (await response.json()).payload.link_id;
    assert.equal((await request(todd, "/slayerlink/invite", "POST", { link_id: id, action: "accept" })).status, 403);
    const incoming = (await (await request(manda, "/slayerlink/invites")).json()).payload.invites;
    assert.equal(incoming[0].linked_account_id, john.UserId);
    assert.equal(incoming[0].direction, "Received");
    assert.equal(incoming[0].status, "Pending");
    assert.equal((await request(manda, "/slayerlink/invite", "POST", { link_id: id, action: "accept" })).status, 200);
    assert.equal((await request(manda, "/slayerlink/invite", "POST", { link_id: id, action: "accept" })).status, 200);
    const a = (await (await request(john, "/slayerlink/links")).json()).payload.links;
    const b = (await (await request(manda, "/slayerlink/links")).json()).payload.links;
    assert.equal(a[0].linked_account_id, manda.UserId);
    assert.equal(b[0].linked_account_id, john.UserId);
    assert.equal(a[0].link_id, b[0].link_id);
    assert.equal(db.select().from(context.Schema.slayerlinks).all().length, 1);
    assert.equal((await request(john, "/slayerlink/invite", "PUT", { account_id: manda.UserId, slot: 0 })).status, 409);
    assert.equal((await request(todd, "/slayerlink/link", "DELETE", { slot: 0 })).status, 200);
    assert.equal((await (await request(john, "/slayerlink/links")).json()).payload.links.length, 1);
});

test("party invite, acceptance, leadership and removal are reflected in party reads", async () => {
    const john = Harness.SeedAccount(context, "PartyJohn");
    const manda = Harness.SeedAccount(context, "PartyManda");
    const todd = Harness.SeedAccount(context, "PartyTodd");
    assert.equal((await request(john, "/party/invite", "PUT", { recipientPlayerId: manda.UserId })).status, 200);
    const invitation = (await (await request(manda, "/party/invites")).json()).invitations[0];
    assert.equal(invitation.sendingPlayerId, john.UserId);
    assert.equal((await request(todd, `/party/invite/accept/${invitation.inviteId}`, "PUT")).status, 404);
    assert.equal((await request(manda, `/party/invite/accept/${invitation.inviteId}`, "PUT")).status, 200);
    const johnParty = await (await request(john, "/party", "POST", {})).json();
    const mandaParty = await (await request(manda, "/party", "POST", {})).json();
    assert.equal(johnParty.partyId, mandaParty.partyId);
    assert.deepEqual(johnParty.playerStates.map(p => p.playerId), [john.UserId, manda.UserId]);
    assert.equal((await request(manda, `/party/member/${john.UserId}`, "DELETE")).status, 403);
    assert.equal((await request(john, `/party/member/promote/${manda.UserId}`, "PUT")).status, 200);
    assert.equal((await (await request(john, "/party", "POST", {})).json()).leaderPlayerId, manda.UserId);
    assert.equal((await request(manda, `/party/member/${john.UserId}`, "DELETE")).status, 200);
    assert.equal((await (await request(manda, "/party", "POST", {})).json()).playerStates.length, 1);
});
