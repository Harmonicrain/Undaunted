"use strict";
// The hunt pass a player chooses on the Hunt Pass selection screen is kept per
// player: the main pass always, an event pass only while its event runs. The
// passes and the event here are synthetic.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Harness = require("./harness");

let Context, Selection, Tracks, Dir;

const Pass = (Id) => ({ progression_id: Id, start_date: "2020-01-01T00:00:00+00:00", end_date: "2020-02-01T00:00:00+00:00",
    requirements: [{ rank_id: 0, xp_required: 0 }, { rank_id: 1, xp_required: 300 }], free_rewards: [], premium_rewards: [] });

before(() => {
    Dir = fs.mkdtempSync(path.join(os.tmpdir(), "huntpass-selection-"));
    const Seasons = path.join(Dir, "seasons");
    fs.mkdirSync(Seasons);
    fs.writeFileSync(path.join(Seasons, "passes.json"), JSON.stringify([
        { ...Pass("season_main"), end_date: "2099-01-01T00:00:00+00:00" }, Pass("eventpass_running"), Pass("eventpass_ended")
    ]));
    fs.writeFileSync(path.join(Dir, "seasonal_events.json"), JSON.stringify({ events: [
        { name: "Running", start: "2026-01-01T00:00:00Z", end: "2099-01-01T00:00:00Z", scheduledItems: ["EVENT_A"], eventPasses: ["eventpass_running"] }
    ] }));
    process.env.HUNT_PASS_SEASONS_DIR = Seasons;
    process.env.ACTIVE_HUNT_PASS = "season_main";
    process.env.SEASONAL_EVENTS_FILE = path.join(Dir, "seasonal_events.json");
    Context = Harness.CreateDisposableDatabase();
    Selection = require("../dist/controllers/huntpassSelection");
    Tracks = require("../dist/controllers/progressionTracks");
});
after(() => {
    for(const Key of ["HUNT_PASS_SEASONS_DIR", "ACTIVE_HUNT_PASS", "SEASONAL_EVENTS_FILE"]) delete process.env[Key];
    Context.Db.$client.close();
    Context.Cleanup();
    fs.rmSync(Dir, { recursive: true, force: true });
});

test("without a choice a player is on the main pass", () => {
    const A = Harness.SeedAccount(Context, "NoChoice");
    assert.equal(Selection.GetSelectedHuntPassId(A.UserId), "season_main");
});

test("a running event's pass can be chosen, is kept, and is sent with progression", () => {
    const A = Harness.SeedAccount(Context, "Chooser");
    Selection.SetSelectedHuntPassId(A.UserId, "eventpass_running");
    assert.equal(Selection.GetSelectedHuntPassId(A.UserId), "eventpass_running");
    assert.deepEqual(Tracks.GetWireProgressionTracks(A.UserId).slice(0, 2).map((T) => T.progression_id), ["season_main", "eventpass_running"]);
    Selection.SetSelectedHuntPassId(A.UserId, "season_main");
    assert.equal(Selection.GetSelectedHuntPassId(A.UserId), "season_main");
});

test("an ended event's pass or an unknown track cannot be chosen", () => {
    const A = Harness.SeedAccount(Context, "Refused");
    assert.throws(() => Selection.SetSelectedHuntPassId(A.UserId, "eventpass_ended"), Selection.HuntPassSelectionError);
    assert.throws(() => Selection.SetSelectedHuntPassId(A.UserId, "MasteryTrack_PlayerLevel"), Selection.HuntPassSelectionError);
    assert.equal(Selection.GetSelectedHuntPassId(A.UserId), "season_main");
});
