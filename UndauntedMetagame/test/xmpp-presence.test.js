"use strict";

// XMPP keep-alive and presence flapping, against a disposable database.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Harness = require("./harness");

let Context, Sign, Session, Presence, Registry;

before(() => {
    const Keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.AUTH_SIGNING_PRIVKEY_B64 = Buffer.from(Keys.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
    process.env.AUTH_SIGNING_PUBKEY_B64 = Buffer.from(Keys.publicKey.export({ type: "spki", format: "pem" })).toString("base64");
    Context = Harness.CreateDisposableDatabase();
    Sign = require("../dist/controllers/auth").SignMetagameJWTForUid;
    Session = require("../dist/realtime/XMPPSession").XMPPSession;
    Presence = require("../dist/realtime/PresenceService");
    Registry = require("../dist/realtime/SessionRegistry").sessionRegistry;
});
after(() => { Context.Db.$client.close(); Context.Cleanup(); });

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function Befriend(A, B) {
    for (const [Owner, Friend] of [[A, B], [B, A]]) {
        Context.Db.insert(Context.Schema.friends).values({ ownerId: Owner.UserId, friendId: Friend.UserId, status: "ACCEPTED", direction: "OUTBOUND", createdAt: new Date().toISOString() }).run();
    }
}
function FakeConnection(Account, Resource) {
    return { connId: crypto.randomUUID(), accountId: Account.UserId, resource: Resource, sent: [], send(Frame) { this.sent.push(Frame); }, close() {} };
}

test("the pong answers the client's ping as the server, addressed to the bound JID", async () => {
    const A = Harness.SeedAccount(Context, "PingA");
    const S = new Session();
    await S.handleFrame('<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" to="prod.ol.epicgames.com"/>');
    const Plain = Buffer.from(`\u0000${A.UserId}\u0000${Sign(A.UserId)}`).toString("base64");
    const Auth = await S.handleFrame(`<auth xmlns="urn:ietf:params:xml:ns:xmpp-sasl" mechanism="PLAIN">${Plain}</auth>`);
    assert.equal(Auth.accountId, A.UserId);
    await S.handleFrame('<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" to="prod.ol.epicgames.com"/>');
    await S.handleFrame('<iq type="set" id="bind_1"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"><resource>V2:Jackal:WIN::ABC</resource></bind></iq>');
    const Pong = await S.handleFrame('<iq type="get" id="ping_7" to="prod.ol.epicgames.com"><ping xmlns="urn:xmpp:ping"/></iq>');
    assert.equal(Pong.send.length, 1);
    assert.match(Pong.send[0], /^<iq type="result" id="ping_7" from="prod\.ol\.epicgames\.com" to="/);
    assert.ok(Pong.send[0].includes(`to="${A.UserId}@prod.ol.epicgames.com/V2:Jackal:WIN::ABC"`));
});

test("a reconnect inside the grace period never announces the player offline", async () => {
    const A = Harness.SeedAccount(Context, "FlapA"), B = Harness.SeedAccount(Context, "FlapB");
    Befriend(A, B);
    const Watcher = FakeConnection(B, "b");
    Registry.bind(B.UserId, "b", Watcher);
    const First = FakeConnection(A, "a1");
    Registry.bind(A.UserId, "a1", First);
    await Presence.onResourceAvailable(A.UserId, "a1");
    // Connection drops...
    Registry.unbind(A.UserId, "a1", First);
    await Presence.onResourceUnavailable(A.UserId, 80);
    // ...and comes back before the grace period ends.
    await wait(20);
    const Second = FakeConnection(A, "a2");
    Registry.bind(A.UserId, "a2", Second);
    await Presence.onResourceAvailable(A.UserId, "a2");
    await wait(120);
    assert.equal(Watcher.sent.filter(Frame => Frame.includes('type="unavailable"')).length, 0);
    // A real departure is still announced once the grace period passes.
    Registry.unbind(A.UserId, "a2", Second);
    await Presence.onResourceUnavailable(A.UserId, 40);
    await wait(80);
    assert.equal(Watcher.sent.filter(Frame => Frame.includes('type="unavailable"')).length, 1);
    Registry.unbind(B.UserId, "b", Watcher);
});
