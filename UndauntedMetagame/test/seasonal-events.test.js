"use strict";
// Seasonal events are switched on from SEASONAL_EVENTS_FILE: the schedule the
// client reads lists every configured event, and the runtime DLL is told the
// feature flags of the events running now. The events here are synthetic.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let Dir, Server, Url;

before(async () => {
    Dir = fs.mkdtempSync(path.join(os.tmpdir(), "seasonal-events-"));
    const File = path.join(Dir, "seasonal_events.json");
    fs.writeFileSync(File, JSON.stringify({ events: [
        { name: "Running", start: "2026-01-01T00:00:00Z", end: "2099-01-01T00:00:00Z",
          scheduledItems: ["EVENT_RUNNING"], featureFlags: ["city_event_running_bpff", "city_event_stall_bpff"] },
        { name: "Over", start: "2020-01-01T00:00:00Z", end: "2020-02-01T00:00:00Z",
          scheduledItems: ["EVENT_OVER"], featureFlags: ["city_event_over_bpff"] }
    ] }));
    process.env.SEASONAL_EVENTS_FILE = File;
    const express = require("express");
    const App = express();
    App.use(require("../dist/routes/tuning").tuningRouter);
    Server = await new Promise((resolve) => { const S = App.listen(0, "127.0.0.1", () => resolve(S)); });
    Url = `http://127.0.0.1:${Server.address().port}`;
});
after(async () => {
    delete process.env.SEASONAL_EVENTS_FILE;
    await new Promise((resolve) => Server.close(resolve));
    fs.rmSync(Dir, { recursive: true, force: true });
});

test("the schedule has a row per event id, named with the id, with ISO 8601 times", async () => {
    // The game finds an event by the row's Name (IsScheduledItemActive), not by
    // the nested ScheduledItems.
    const Body = await (await fetch(`${Url}/game_tuning/seasonal_event_schedule`)).json();
    assert.equal(Body.message, "OK");
    assert.deepEqual(Body.payload.ScheduledItems.map((Row) => [Row.Name, Row.StartTime, Row.EndTime, Row.ScheduledItems]), [
        ["EVENT_RUNNING", "2026-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z", [{ ID: "EVENT_RUNNING" }]],
        ["EVENT_OVER", "2020-01-01T00:00:00.000Z", "2020-02-01T00:00:00.000Z", [{ ID: "EVENT_OVER" }]]
    ]);
});

test("only the running events' feature flags are forced on", async () => {
    const Body = await (await fetch(`${Url}/undaunted/feature_flags`)).json();
    assert.deepEqual(Body.payload.enabled, ["city_event_running_bpff", "city_event_stall_bpff"]);
});
