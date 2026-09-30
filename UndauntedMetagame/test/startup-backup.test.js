"use strict";
// Startup copies an existing database aside before it changes it: before
// pending schema migrations and before a data repair with rows to fix. The
// databases here are disposable; the older one is made by migrating from a
// copy of the migrations folder without its newest migration.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AssertDisposable } = require("./harness");

process.env.LOG_LEVEL = "silent";

const PackageRoot = path.resolve(__dirname, "..");
let Directory, DbPath, OldFilename;

// A fresh copy of dist/db.js, so each start runs InitializeDatabase anew.
function Start(Cwd) {
    const Previous = process.cwd();
    delete require.cache[require.resolve("../dist/db")];
    process.chdir(Cwd);
    try {
        return require("../dist/db").InitializeDatabase();
    } finally {
        process.chdir(Previous);
    }
}
const Backups = (Reason) => fs.readdirSync(Directory).filter(Name => Name.startsWith(`test.sqlite.bak-pre${Reason}-`));

before(() => {
    Directory = fs.mkdtempSync(path.join(os.tmpdir(), "undaunted-backup-"));
    DbPath = AssertDisposable(path.join(Directory, "test.sqlite"));
    OldFilename = process.env.DB_FILENAME;
    process.env.DB_FILENAME = DbPath;
});
after(() => {
    if (OldFilename === undefined) delete process.env.DB_FILENAME; else process.env.DB_FILENAME = OldFilename;
    fs.rmSync(Directory, { recursive: true, force: true });
});

test("a new database is created without a backup", () => {
    const Older = path.join(Directory, "older");
    fs.cpSync(path.join(PackageRoot, "src", "drizzle"), path.join(Older, "src", "drizzle"), { recursive: true });
    const JournalPath = path.join(Older, "src", "drizzle", "meta", "_journal.json");
    const Journal = JSON.parse(fs.readFileSync(JournalPath, "utf8"));
    Journal.entries = Journal.entries.slice(0, -1);
    fs.writeFileSync(JournalPath, JSON.stringify(Journal));

    Start(Older).$client.close();
    assert.deepEqual(Backups("Migration"), []);
    assert.deepEqual(Backups("Repair"), []);
});

test("pending migrations are applied only after a backup of the older database", () => {
    const Db = Start(PackageRoot);
    const Applied = Db.$client.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations").get().n;
    Db.$client.close();

    const Taken = Backups("Migration");
    assert.equal(Taken.length, 1);
    const Copy = new (require("better-sqlite3"))(path.join(Directory, Taken[0]), { readonly: true });
    try {
        // The copy is the database as it was: one migration behind.
        assert.equal(Copy.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations").get().n, Applied - 1);
    } finally {
        Copy.close();
    }
});

test("a repair with rows to fix is preceded by a backup; a clean start takes none", () => {
    let Db = Start(PackageRoot);
    Db.$client.prepare("INSERT INTO wallets (userId, currencyId, amount, updatedAt) VALUES (?, ?, ?, ?)")
        .run("UID-backup-test", "CURRENCY_TOKEN_EXCHANGE_SPEED_UP", 3, Date.now());
    Db.$client.close();

    Db = Start(PackageRoot);
    const Dust = Db.$client.prepare("SELECT amount FROM wallets WHERE userId = ? AND currencyId = ?")
        .get("UID-backup-test", "CURRENCY_CELLDUST");
    Db.$client.close();
    assert.equal(Dust.amount, 12);
    assert.equal(Backups("Repair").length, 1);

    Start(PackageRoot).$client.close();
    assert.equal(Backups("Repair").length, 1);
    assert.equal(Backups("Migration").length, 1);
});
