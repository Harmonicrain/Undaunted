"use strict";

// Character saves against a disposable database: an equal-version re-send
// from the client is accepted, an empty payload never wipes a character.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const Harness = require("./harness");

let Context, Characters;

before(() => {
    Context = Harness.CreateDisposableDatabase();
    Characters = require("../dist/controllers/character");
});
after(() => {
    Context.Db.$client.close();
    Context.Cleanup();
});

function Stored(Account) {
    const { eq } = require("drizzle-orm");
    return Context.Db.select().from(Context.Schema.characters)
        .where(eq(Context.Schema.characters.characterId, Account.CharacterId)).get();
}

test("an equal-version re-send with newer client state is accepted", async () => {
    const A = Harness.SeedAccount(Context, "Resender");
    assert.equal(await Characters.UpdateCharacterForUid(A.CharacterId, A.UserId, JSON.stringify({ RecentPlayers: ["a"] }), 1), true);
    assert.equal(await Characters.UpdateCharacterForUid(A.CharacterId, A.UserId, JSON.stringify({ RecentPlayers: ["a", "b"] }), 1), true);
    assert.deepEqual(JSON.parse(Stored(A).data).RecentPlayers, ["a", "b"]);
});

test("an empty save cannot wipe a character, at the same or a newer version", async () => {
    const A = Harness.SeedAccount(Context, "Keeper");
    const Progress = JSON.stringify({ SERIE_test: { ID: "test", Q1: { Status: 3 } } });
    assert.equal(await Characters.UpdateCharacterForUid(A.CharacterId, A.UserId, Progress, 1), true);
    assert.equal(await Characters.UpdateCharacterForUid(A.CharacterId, A.UserId, "{}", 1), false);
    assert.equal(await Characters.UpdateCharacterForUid(A.CharacterId, A.UserId, "{}", 2), false);
    assert.equal(await Characters.UpdateCharacterForUid(A.CharacterId, A.UserId, "", 3), false);
    assert.equal(Stored(A).updateVersion, 1);
    assert.equal(JSON.parse(Stored(A).data).SERIE_test.Q1.Status, 3);
});

test("an older version is still refused", async () => {
    const A = Harness.SeedAccount(Context, "Stale");
    assert.equal(await Characters.UpdateCharacterForUid(A.CharacterId, A.UserId, JSON.stringify({ X: 2 }), 2), true);
    assert.equal(await Characters.UpdateCharacterForUid(A.CharacterId, A.UserId, JSON.stringify({ X: 1 }), 1), false);
    assert.equal(JSON.parse(Stored(A).data).X, 2);
});
