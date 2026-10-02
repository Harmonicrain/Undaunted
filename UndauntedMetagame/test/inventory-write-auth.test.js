"use strict";

// Only world servers change inventory; a player's own token can read it but
// cannot grant itself items or wallet currency. Disposable database.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Harness = require("./harness");

let Context, Server, Base, Sign, Wallet;
const GameKey = crypto.randomBytes(32).toString("hex");

before(async () => {
    delete process.env.INVENTORY_WRITES;
    const Keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.AUTH_SIGNING_PRIVKEY_B64 = Buffer.from(Keys.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
    process.env.AUTH_SIGNING_PUBKEY_B64 = Buffer.from(Keys.publicKey.export({ type: "spki", format: "pem" })).toString("base64");
    Context = Harness.CreateDisposableDatabase();
    Sign = require("../dist/controllers/auth").SignMetagameJWTForUid;
    Wallet = require("../dist/features/wallet/wallet");
    Context.Db.insert(Context.Schema.gameserverapikeys).values({ keyHash: crypto.createHash("sha256").update(GameKey).digest("hex") }).run();
    const App = require("express")();
    App.use(require("express").json());
    App.use(require("../dist/routes/inventory").inventoryRouter);
    Server = await new Promise(resolve => { const S = App.listen(0, "127.0.0.1", () => resolve(S)); });
    Base = `http://127.0.0.1:${Server.address().port}`;
});
after(async () => {
    await new Promise(resolve => Server.close(resolve));
    Context.Db.$client.close();
    Context.Cleanup();
});

async function Call(Path, { account, gameserver = false, method = "GET", body } = {}) {
    const Response = await fetch(Base + Path, { method, headers: {
        "content-type": "application/json",
        ...(account ? { authorization: `bearer ${Sign(account.UserId)}` } : {}),
        ...(gameserver ? { "x-undaunted-gameserver-apikey": GameKey } : {})
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: Response.status, text: await Response.text() };
}

function Platinum(Account) {
    return Wallet.WalletBalance(Context.Db, Account.UserId, "CURRENCY_PLATINUM");
}

test("a player token cannot add Platinum or items to its own character", async () => {
    const A = Harness.SeedAccount(Context, "Printer");
    const Forged = await Call("/inventory", { account: A, method: "POST", body: {
        characterId: A.CharacterId, transactionId: crypto.randomUUID(),
        addStackedItems: [{ catalogId: "CURRENCY_PLATINUM", quantity: 1000000 }, { catalogId: "CURRENCY_NOTES", quantity: 50000 }],
        addInstancedItems: [], removeInstancedItems: [], removeStackedItems: [], saveInstancedItems: [] } });
    assert.equal(Forged.status, 403);
    assert.equal(Platinum(A), 0);
    assert.equal(Harness.StackedQuantity(Harness.ReadInventory(Context, A.CharacterId), "CURRENCY_NOTES"), 0);

    const Item = await Call("/inventory/instanceditem", { account: A, method: "POST", body: {
        characterId: A.CharacterId, instanceId: crypto.randomUUID(), catalogId: "WEAPON_ANY", itemData: "{}", updateVersion: 1 } });
    assert.equal(Item.status, 403);
});

test("a world server still grants items and currency for a player", async () => {
    const A = Harness.SeedAccount(Context, "Hunter");
    const Grant = await Call("/inventory", { gameserver: true, method: "POST", body: {
        accountId: A.UserId, characterId: A.CharacterId, transactionId: crypto.randomUUID(),
        addStackedItems: [{ catalogId: "CURRENCY_PLATINUM", quantity: 25 }, { catalogId: "CURRENCY_NOTES", quantity: 400 }],
        addInstancedItems: [], removeInstancedItems: [], removeStackedItems: [], saveInstancedItems: [] } });
    assert.equal(Grant.status, 200, Grant.text);
    assert.equal(Platinum(A), 25);
    assert.equal(Harness.StackedQuantity(Harness.ReadInventory(Context, A.CharacterId), "CURRENCY_NOTES"), 400);
});

test("a player can still read their own inventory", async () => {
    const A = Harness.SeedAccount(Context, "Reader");
    const Read = await Call(`/inventory/${A.UserId}/${A.CharacterId}`, { account: A });
    assert.equal(Read.status, 200, Read.text);
});
