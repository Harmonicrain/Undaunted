"use strict";

// Disposable database harness.
//
// src/db.ts binds process.env.DB_FILENAME at module load, so DB_FILENAME must
// be set before anything that reaches db.js is required. Every helper here
// takes that into account: nothing from dist/ is required until the env is set.
//
// F01's acceptance is that the test setup never reads or writes the live player
// database. That is enforced below rather than left as an intention.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

// Anything under here is real player data and is off limits to tests.
const PROTECTED_DIRECTORIES = [
    path.resolve("E:/Dauntless/data"),
];

function AssertDisposable(DbPath) {
    const Resolved = path.resolve(DbPath);

    for (const Protected of PROTECTED_DIRECTORIES) {
        if (Resolved === Protected || Resolved.startsWith(Protected + path.sep)) {
            throw new Error(
                `Refusing to run tests against ${Resolved}: that is live player data. ` +
                `Tests must use a disposable database.`);
        }
    }

    const TempRoot = path.resolve(os.tmpdir());

    if (!Resolved.startsWith(TempRoot + path.sep)) {
        throw new Error(
            `Refusing to run tests against ${Resolved}: expected a path under ${TempRoot}.`);
    }

    return Resolved;
}

// Migrations resolve "./src/drizzle" relative to the working directory, so the
// runner has to start from the package root. Fail loudly rather than silently
// migrating nothing.
function AssertWorkingDirectory() {
    const Migrations = path.resolve("./src/drizzle");

    if (!fs.existsSync(Migrations)) {
        throw new Error(
            `Migrations not found at ${Migrations}. Run the tests from the UndauntedMetagame package root.`);
    }
}

function CreateDisposableDatabase() {
    AssertWorkingDirectory();

    const Directory = fs.mkdtempSync(path.join(os.tmpdir(), "undaunted-test-"));
    const DbPath = AssertDisposable(path.join(Directory, "test.sqlite"));

    process.env.DB_FILENAME = DbPath;
    process.env.LOG_LEVEL = process.env.LOG_LEVEL || "silent";
    // controllers/auth.ts decodes these at module load; tests never sign anything
    // but a require() further up the graph must not crash on undefined.
    process.env.AUTH_SIGNING_PRIVKEY_B64 = process.env.AUTH_SIGNING_PRIVKEY_B64 || Buffer.from("unused").toString("base64");
    process.env.AUTH_SIGNING_PUBKEY_B64 = process.env.AUTH_SIGNING_PUBKEY_B64 || Buffer.from("unused").toString("base64");

    // Only now is it safe to pull in anything that reaches db.js.
    const { GetDb } = require("../dist/db.js");
    const Schema = require("../dist/db/schema.js");

    const Db = GetDb(); // also runs migrations

    return {
        Db,
        Schema,
        DbPath,
        Cleanup() {
            try {
                fs.rmSync(Directory, { recursive: true, force: true });
            } catch {
                // a held file handle on Windows is not worth failing a test over
            }
        }
    };
}

// Seeds one account and one character, mirroring what RegisterUser and
// CreateCharacterForUid produce, without going through the HTTP layer.
function SeedAccount(Context, Name = "TestSlayer") {
    const { Db, Schema } = Context;

    const UserId = `UID-${crypto.randomUUID()}`;
    const CharacterId = crypto.randomUUID();
    const Now = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

    Db.insert(Schema.users).values({
        userId: UserId,
        name: Name,
        notes: 0,
        isAdmin: false
    }).run();

    Db.insert(Schema.characters).values({
        characterId: CharacterId,
        userId: UserId,
        name: Name,
        createdDate: Now,
        lastModifiedDate: Now,
        updateVersion: 0,
        data: "{}"
    }).run();

    return { UserId, CharacterId };
}

function ReadInventory(Context, CharacterId) {
    const { Db, Schema } = Context;
    const { eq } = require("drizzle-orm");

    const Row = Db.select().from(Schema.inventory)
        .where(eq(Schema.inventory.characterId, CharacterId)).all()[0];

    if (Row == undefined) {
        return { instancedItems: [], stackedItems: [] };
    }

    return {
        instancedItems: JSON.parse(Row.instancedItems),
        stackedItems: JSON.parse(Row.stackedItems)
    };
}

function StackedQuantity(Inventory, CatalogId) {
    const Item = Inventory.stackedItems.find((Entry) => Entry.catalogId === CatalogId);

    return Item == undefined ? 0 : Item.quantity;
}

module.exports = {
    CreateDisposableDatabase,
    SeedAccount,
    ReadInventory,
    StackedQuantity,
    AssertDisposable
};
