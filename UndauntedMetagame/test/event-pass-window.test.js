"use strict";
// An event pass is served with its seasonal event's window, so the client
// opens it for the event rather than for the dates of its last live run. The
// pass and the event here are synthetic.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let Dir, HuntPass;

before(() => {
    Dir = fs.mkdtempSync(path.join(os.tmpdir(), "event-pass-"));
    const Seasons = path.join(Dir, "seasons");
    fs.mkdirSync(Seasons);
    fs.writeFileSync(path.join(Seasons, "passes.json"), JSON.stringify([
        { progression_id: "eventpass_test", start_date: "2024-10-22T18:00:00+00:00", end_date: "2024-11-05T17:00:00+00:00",
          requirements: [{ rank_id: 0, xp_required: 0 }], free_rewards: [], premium_rewards: [] },
        { progression_id: "eventpass_other", start_date: "2021-01-01T00:00:00+00:00", end_date: "2021-02-01T00:00:00+00:00",
          requirements: [{ rank_id: 0, xp_required: 0 }], free_rewards: [], premium_rewards: [] }
    ]));
    const Events = path.join(Dir, "seasonal_events.json");
    fs.writeFileSync(Events, JSON.stringify({ events: [
        { name: "Test Event", start: "2026-09-25T00:00:00Z", end: "2026-11-06T00:00:00Z",
          scheduledItems: ["EVENT_TEST"], eventPasses: ["eventpass_test"] }
    ] }));
    process.env.HUNT_PASS_SEASONS_DIR = Seasons;
    process.env.SEASONAL_EVENTS_FILE = Events;
    HuntPass = require("../dist/controllers/huntpass");
});
after(() => {
    delete process.env.HUNT_PASS_SEASONS_DIR;
    delete process.env.SEASONAL_EVENTS_FILE;
    fs.rmSync(Dir, { recursive: true, force: true });
});

test("an event's pass is served with the event's window; other passes keep theirs", () => {
    const Paths = HuntPass.GetProgressionConfigPayload().payload.paths;
    const Find = (Id) => Paths.find((Path) => Path.progression_id === Id);
    assert.deepEqual([Find("eventpass_test").start_date, Find("eventpass_test").end_date],
        ["2026-09-25T00:00:00+00:00", "2026-11-06T00:00:00+00:00"]);
    assert.deepEqual([Find("eventpass_other").start_date, Find("eventpass_other").end_date],
        ["2021-01-01T00:00:00+00:00", "2021-02-01T00:00:00+00:00"]);
});
