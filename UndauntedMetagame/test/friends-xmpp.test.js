"use strict";

// Friend list changes reach connected clients as Epic friends-service
// messages from xmpp-admin; without them an accepted or removed request stays
// "pending" in an open client until the next login.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Harness = require("./harness");

let Context, Server, Base, Sign, Registry;

before(async () => {
    const Keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.AUTH_SIGNING_PRIVKEY_B64 = Buffer.from(Keys.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
    process.env.AUTH_SIGNING_PUBKEY_B64 = Buffer.from(Keys.publicKey.export({ type: "spki", format: "pem" })).toString("base64");
    Context = Harness.CreateDisposableDatabase();
    Sign = require("../dist/controllers/auth").SignMetagameJWTForUid;
    Registry = require("../dist/realtime/SessionRegistry").sessionRegistry;
    const App = require("express")();
    App.use(require("express").json());
    App.use(require("../dist/routes/friends").friendsRouter);
    Server = await new Promise(resolve => { const S = App.listen(0, "127.0.0.1", () => resolve(S)); });
    Base = `http://127.0.0.1:${Server.address().port}`;
});
after(async () => { await new Promise(resolve => Server.close(resolve)); Context.Db.$client.close(); Context.Cleanup(); });

function Connect(Account) {
    const Connection = { connId: crypto.randomUUID(), accountId: Account.UserId, resource: "r", sent: [], send(Frame) { this.sent.push(Frame); }, close() {} };
    Registry.bind(Account.UserId, "r", Connection);
    return Connection;
}
async function Call(Account, Method, Path) {
    return (await fetch(Base + Path, { method: Method, headers: { authorization: `bearer ${Sign(Account.UserId)}` } })).status;
}
// The friends messages a connection received since the last call.
function Take(Connection) {
    const Out = Connection.sent.filter(Frame => Frame.startsWith("<message")).map(Frame => {
        assert.match(Frame, /^<message id="friends-[^"]+" from="xmpp-admin@prod\.ol\.epicgames\.com" to="[^"]+@prod\.ol\.epicgames\.com"><body>/);
        const Body = Frame.slice(Frame.indexOf("<body>") + 6, Frame.indexOf("</body>"))
            .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
        return JSON.parse(Body);
    });
    Connection.sent.length = 0;
    return Out;
}

test("request, accept and removal are pushed to both players as they happen", async () => {
    const John = Harness.SeedAccount(Context, "PushJohn"), Todd = Harness.SeedAccount(Context, "PushTodd");
    const J = Connect(John), T = Connect(Todd);
    const FRIEND = "com.epicgames.friends.core.apiobjects.Friend";
    const REMOVAL = "com.epicgames.friends.core.apiobjects.FriendRemoval";

    assert.equal(await Call(John, "POST", `/friends/api/public/friends/${John.UserId}/${Todd.UserId}`), 204);
    let [ToJohn] = Take(J), [ToTodd] = Take(T);
    assert.equal(ToJohn.type, FRIEND);
    assert.deepEqual([ToJohn.payload.accountId, ToJohn.payload.status, ToJohn.payload.direction], [Todd.UserId, "PENDING", "OUTBOUND"]);
    assert.deepEqual([ToTodd.payload.accountId, ToTodd.payload.status, ToTodd.payload.direction], [John.UserId, "PENDING", "INBOUND"]);
    assert.ok(!Number.isNaN(Date.parse(ToTodd.timestamp)));

    // Accepting updates both open clients, not just the database.
    assert.equal(await Call(Todd, "POST", `/friends/api/public/friends/${Todd.UserId}/${John.UserId}`), 204);
    [ToJohn] = Take(J); [ToTodd] = Take(T);
    assert.deepEqual([ToJohn.type, ToJohn.payload.accountId, ToJohn.payload.status], [FRIEND, Todd.UserId, "ACCEPTED"]);
    assert.deepEqual([ToTodd.type, ToTodd.payload.accountId, ToTodd.payload.status], [FRIEND, John.UserId, "ACCEPTED"]);
    // The entry matches what a fresh GET would return.
    const Listed = await (await fetch(`${Base}/friends/api/public/friends/${Todd.UserId}?includePending=true`, { headers: { authorization: `bearer ${Sign(Todd.UserId)}` } })).json();
    assert.deepEqual(Listed, [{ ...ToTodd.payload }]);

    // Removal drops the entry on both sides.
    assert.equal(await Call(Todd, "DELETE", `/friends/api/public/friends/${Todd.UserId}/${John.UserId}`), 204);
    [ToJohn] = Take(J); [ToTodd] = Take(T);
    assert.deepEqual(ToJohn, { type: REMOVAL, payload: { accountId: Todd.UserId, reason: "DELETED" }, timestamp: ToJohn.timestamp });
    assert.deepEqual(ToTodd.payload, { accountId: John.UserId, reason: "DELETED" });

    // Declining a received request removes it the same way.
    await Call(John, "POST", `/friends/api/public/friends/${John.UserId}/${Todd.UserId}`);
    Take(J); Take(T);
    await Call(Todd, "DELETE", `/friends/api/public/friends/${Todd.UserId}/${John.UserId}`);
    assert.equal(Take(J)[0].type, REMOVAL);
    assert.equal(Take(T)[0].type, REMOVAL);

    // A player who is offline simply reads the list at login.
    Registry.unbind(Todd.UserId, "r", T);
    assert.equal(await Call(John, "POST", `/friends/api/public/friends/${John.UserId}/${Todd.UserId}`), 204);
    assert.equal(Take(J).length, 1);
    assert.equal(T.sent.length, 0);
    Registry.unbind(John.UserId, "r", J);
});
