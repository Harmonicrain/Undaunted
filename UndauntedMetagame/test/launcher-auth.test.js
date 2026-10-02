"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
process.env.AUTH_MODE = "APIKEY";
process.env.REGISTRATION_MODE = "OPEN";
const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
process.env.AUTH_SIGNING_PRIVKEY_B64 = Buffer.from(keys.privateKey).toString("base64");
process.env.AUTH_SIGNING_PUBKEY_B64 = Buffer.from(keys.publicKey).toString("base64");
const { CreateDisposableDatabase, SeedAccount } = require("./harness");
const context = CreateDisposableDatabase();
const db = context.Db.$client;
const auth = require("../dist/controllers/launcherAuth");
const { SetRegistrationMode } = require("../dist/controllers/undauntedapi");
const { app } = require("../dist/app");
const server = app.listen(0, "127.0.0.1");
const ready = new Promise(resolve => server.on("listening", resolve));
after(async () => { await new Promise(resolve => server.close(resolve)); context.Cleanup(); });
const password = "a long test password";
async function request(route, body, token) {
    await ready;
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers };
}
test("registration creates a playable identity, stores only hashes, and prevents duplicate names", async () => {
    SetRegistrationMode("OPEN");
    const result = await request("/launcher/v1/register", { username: "NewSlayer", password });
    assert.equal(result.status, 200);
    const session = result.body;
    assert.match(session.accessToken, /^ULA_[0-9a-f]{64}$/);
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.equal(db.prepare("SELECT count(*) AS n FROM users WHERE userId=?").get(session.user.userId).n, 1);
    assert.match(db.prepare("SELECT passwordHash FROM launchercredentials WHERE userId=?").get(session.user.userId).passwordHash, /^\$argon2id\$/);
    const stored = db.prepare("SELECT * FROM launchersessions WHERE userId=?").get(session.user.userId);
    assert.equal(stored.accessHash, auth.TokenHash(session.accessToken));
    assert.equal(stored.refreshHash, auth.TokenHash(session.refreshToken));
    assert.ok(!JSON.stringify(stored).includes(session.refreshToken));
    assert.equal((await request("/launcher/v1/register", { username: "newslayer", password })).status, 409);
    assert.equal((await request("/launcher/v1/login", { username: "NEWSLAYER", password })).status, 200);
    assert.equal((await request("/launcher/v1/login", { username: "NewSlayer", password: "wrong password" })).status, 401);
    const exchange = await request("/launcher/v1/exchange", {}, session.accessToken);
    assert.equal(exchange.status, 200);
    const eos = await request("/account/api/oauth/token", { exchange_code: exchange.body.exchangeCode });
    assert.equal(eos.status, 200);
    assert.equal(eos.body.account_id, session.user.userId);
    assert.ok(eos.body.access_token);
    // A code can only be redeemed once, including when requests race.
    assert.equal(auth.ConsumeLauncherExchange(exchange.body.exchangeCode), undefined);
});
test("refresh rotates both tokens; stale credentials and logout cannot launch", async () => {
    const session = await auth.LoginLauncherAccount("NewSlayer", password);
    const oldCode = auth.IssueLauncherExchange(session.accessToken).exchangeCode;
    const fresh = auth.RefreshLauncherSession(session.refreshToken);
    assert.notEqual(fresh.refreshToken, session.refreshToken);
    assert.throws(() => auth.RefreshLauncherSession(session.refreshToken), /sign in again/);
    assert.throws(() => auth.RequireLauncherSession(session.accessToken), /sign in again/);
    assert.equal(auth.ConsumeLauncherExchange(oldCode), undefined);
    const newCode = auth.IssueLauncherExchange(fresh.accessToken).exchangeCode;
    auth.LogoutLauncherSession(fresh.refreshToken);
    assert.throws(() => auth.RequireLauncherSession(fresh.accessToken), /sign in again/);
    assert.equal(auth.ConsumeLauncherExchange(newCode), undefined);
});
test("claim retains the player, character and key and cannot reset an already claimed account", async () => {
    const seeded = SeedAccount(context, "Veteran");
    const key = "UUK_" + crypto.randomBytes(24).toString("hex");
    db.prepare("INSERT INTO userapikeys (userId,keyHash) VALUES (?,?)").run(seeded.UserId, auth.TokenHash(key));
    const result = await auth.ClaimLauncherAccount(key, password);
    assert.equal(result.user.userId, seeded.UserId);
    assert.equal(db.prepare("SELECT userId FROM characters WHERE characterId=?").get(seeded.CharacterId).userId, seeded.UserId);
    assert.equal(db.prepare("SELECT count(*) AS n FROM userapikeys WHERE userId=?").get(seeded.UserId).n, 1);
    await assert.rejects(auth.ClaimLauncherAccount(key, "a replacement password"), /already has a password/);
    assert.equal((await auth.LoginLauncherAccount("Veteran", password)).user.userId, seeded.UserId);
    const legacy = await request("/account/api/oauth/token", { exchange_code: key });
    assert.equal(legacy.body.account_id, seeded.UserId);
});
test("invite use and registration commit together; failed signup keeps the invitation", async () => {
    SetRegistrationMode("INVITECODE");
    db.prepare("INSERT INTO invitecodes (inviteCode,usesRemaining,infiniteUses) VALUES ('friends',1,0)").run();
    await assert.rejects(auth.RegisterLauncherAccount("NewSlayer", password, "friends"), /already taken/);
    assert.equal(db.prepare("SELECT usesRemaining FROM invitecodes WHERE inviteCode='friends'").get().usesRemaining, 1);
    await assert.rejects(auth.RegisterLauncherAccount("Invited", password, "wrong"), /valid invitation/);
    const results = await Promise.allSettled([
        auth.RegisterLauncherAccount("Invited", password, "friends"),
        auth.RegisterLauncherAccount("OtherInvited", password, "friends")
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(db.prepare("SELECT usesRemaining FROM invitecodes WHERE inviteCode='friends'").get().usesRemaining, 0);
    SetRegistrationMode("NONE");
    await assert.rejects(auth.RegisterLauncherAccount("Closed", password, undefined), /closed/);
    SetRegistrationMode("OPEN");
});
test("legacy registration cannot bypass username uniqueness or consume an invite on a duplicate", async () => {
    const { RegisterUser } = require("../dist/controllers/undauntedapi");
    db.prepare("INSERT INTO invitecodes (inviteCode,usesRemaining,infiniteUses) VALUES ('legacy',1,0)").run();
    assert.equal(await RegisterUser("newslayer", "legacy"), undefined);
    assert.equal(db.prepare("SELECT usesRemaining FROM invitecodes WHERE inviteCode='legacy'").get().usesRemaining, 1);
    assert.ok(await RegisterUser("LegacySlayer", "legacy"));
    assert.equal(db.prepare("SELECT usesRemaining FROM invitecodes WHERE inviteCode='legacy'").get().usesRemaining, 0);
});
test("expired, replaced and missing exchange codes fail without falling back to permanent keys", async () => {
    const session = await auth.LoginLauncherAccount("NewSlayer", password);
    const code = auth.IssueLauncherExchange(session.accessToken).exchangeCode;
    const replacement = auth.IssueLauncherExchange(session.accessToken).exchangeCode;
    assert.equal(auth.ConsumeLauncherExchange(code), undefined);
    db.prepare("UPDATE launcherexchanges SET expiresAt=0 WHERE codeHash=?").run(auth.TokenHash(replacement));
    assert.equal(auth.ConsumeLauncherExchange(replacement), undefined);
    assert.equal((await request("/account/api/oauth/token", {})).status, 400);
    assert.equal((await request("/launcher/v1/exchange", {})).status, 401);
    db.prepare("UPDATE launchersessions SET accessExpiresAt=0 WHERE accessHash=?").run(auth.TokenHash(session.accessToken));
    assert.throws(() => auth.IssueLauncherExchange(session.accessToken), /sign in again/);
    db.prepare("UPDATE launchersessions SET refreshExpiresAt=0 WHERE refreshHash=?").run(auth.TokenHash(session.refreshToken));
    assert.throws(() => auth.RefreshLauncherSession(session.refreshToken), /sign in again/);
});
test("invalid names, short passwords, large bodies, malformed JSON and repeated logins are rejected", async () => {
    await assert.rejects(auth.RegisterLauncherAccount("bad name", password, undefined), /username/);
    await assert.rejects(auth.RegisterLauncherAccount("ValidName", "short", undefined), /12–128/);
    const huge = await request("/launcher/v1/login", { username: "NewSlayer", password: "x".repeat(9000) });
    assert.equal(huge.status, 400);
    assert.ok(!JSON.stringify(huge.body).includes("xxxxxxxx"));
    const malformed = await fetch(`http://127.0.0.1:${server.address().port}/launcher/v1/login`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: '{"password":"secret"'
    });
    assert.equal(malformed.status, 400);
    assert.ok(!(await malformed.text()).includes("secret"));
    let limited;
    for (let i = 0; i < 31; i++) {
        limited = await request("/launcher/v1/login", { username: "nonexistent", password: "wrong password" });
        if (limited.status === 429) break;
    }
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
});
