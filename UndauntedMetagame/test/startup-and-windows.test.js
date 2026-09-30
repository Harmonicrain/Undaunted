"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AssertDisposable } = require("./harness");

process.env.LOG_LEVEL = "silent";

test("database imports and getters do not create or migrate a database", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "undaunted-startup-"));
    const filename = AssertDisposable(path.join(directory, "startup.sqlite"));
    const oldFilename = process.env.DB_FILENAME;
    const oldCwd = process.cwd();
    let db;
    try {
        process.env.DB_FILENAME = filename;
        const { InitializeDatabase, GetDb } = require("../dist/db");
        assert.equal(fs.existsSync(filename), false);
        assert.throws(GetDb, /has not been initialized/);
        assert.equal(fs.existsSync(filename), false);

        // Failed migrations must close the connection and leave initialization
        // retryable, rather than exposing a partly initialized database.
        process.chdir(directory);
        assert.throws(InitializeDatabase);
        assert.throws(GetDb, /has not been initialized/);
        process.chdir(oldCwd);
        db = InitializeDatabase();
        assert.equal(GetDb(), db);
        assert.equal(InitializeDatabase(), db);
        assert.ok(db.$client.prepare("SELECT name FROM sqlite_master WHERE name = 'users'").get());
    } finally {
        process.chdir(oldCwd);
        if (db) db.$client.close();
        if (oldFilename === undefined) delete process.env.DB_FILENAME;
        else process.env.DB_FILENAME = oldFilename;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("startup refuses invalid listener settings before binding a port", () => {
    const { HttpListenerConfig } = require("../dist/config/environment");
    const oldPort = process.env.PORT;
    const oldHost = process.env.HOST;
    try {
        for (const port of ["", "0", "65536", "61000.5", "no-port"]) {
            process.env.PORT = port;
            assert.throws(HttpListenerConfig, /PORT must be an integer/);
        }
        process.env.PORT = "61000";
        delete process.env.HOST;
        assert.deepEqual(HttpListenerConfig(), { host: "127.0.0.1", port: 61000 });
        process.env.HOST = "0.0.0.0";
        assert.equal(HttpListenerConfig().host, "0.0.0.0");
    } finally {
        if (oldPort === undefined) delete process.env.PORT; else process.env.PORT = oldPort;
        if (oldHost === undefined) delete process.env.HOST; else process.env.HOST = oldHost;
    }
});

test("challenge and store reset boundaries retain their different UTC policies", () => {
    const { DailyWindowStart, WeeklyWindowStart, ResetWindows: windows } = require("../dist/shared/timeWindows");
    const before = Date.parse("2026-10-01T17:59:59.999Z");
    const boundary = Date.parse("2026-10-01T18:00:00Z");
    for (const policy of [windows.weeklyChallenges, windows.middleman]) {
        assert.equal(WeeklyWindowStart(before, policy.dayUtc, policy.hourUtc), Date.parse("2026-09-24T18:00:00Z"));
        assert.equal(WeeklyWindowStart(boundary, policy.dayUtc, policy.hourUtc), boundary);
    }
    assert.equal(WeeklyWindowStart(before, windows.weeklyStore.dayUtc, windows.weeklyStore.hourUtc), Date.parse("2026-10-01T00:00:00Z"));
    const dailyBefore = Date.parse("2026-10-01T16:59:59.999Z");
    assert.equal(DailyWindowStart(dailyBefore, windows.dailyChallenges.hourUtc), Date.parse("2026-09-30T17:00:00Z"));
    assert.equal(DailyWindowStart(dailyBefore, windows.dailyStore.hourUtc), Date.parse("2026-10-01T00:00:00Z"));
});
