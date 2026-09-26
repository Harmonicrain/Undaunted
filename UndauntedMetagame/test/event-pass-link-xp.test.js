"use strict";
// Slayer Link XP comes from Hunt Pass XP on whichever pass earned it: the
// season's main pass or the event pass the player has chosen, once per award.
// The passes, the event and the link here are synthetic.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Harness = require("./harness");

let Context, Writes, Selection, Links, Party, Dir;

const Pass = (Id, End) => ({ progression_id: Id, start_date: "2020-01-01T00:00:00+00:00", end_date: End,
    requirements: [{ rank_id: 0, xp_required: 0 }, { rank_id: 1, xp_required: 10000 }], free_rewards: [], premium_rewards: [] });

before(() => {
    Dir = fs.mkdtempSync(path.join(os.tmpdir(), "event-pass-links-"));
    const Seasons = path.join(Dir, "seasons");
    fs.mkdirSync(Seasons);
    fs.writeFileSync(path.join(Seasons, "passes.json"), JSON.stringify([
        Pass("season_main", "2099-01-01T00:00:00+00:00"), Pass("eventpass_running", "2020-02-01T00:00:00+00:00")
    ]));
    fs.writeFileSync(path.join(Dir, "seasonal_events.json"), JSON.stringify({ events: [
        { name: "Running", start: "2026-01-01T00:00:00Z", end: "2099-01-01T00:00:00Z", scheduledItems: ["EVENT_A"], eventPasses: ["eventpass_running"] }
    ] }));
    process.env.HUNT_PASS_SEASONS_DIR = Seasons;
    process.env.ACTIVE_HUNT_PASS = "season_main";
    process.env.SEASONAL_EVENTS_FILE = path.join(Dir, "seasonal_events.json");
    Context = Harness.CreateDisposableDatabase();
    Writes = require("../dist/controllers/progressionWrites");
    Selection = require("../dist/controllers/huntpassSelection");
    Links = require("../dist/controllers/slayerLinks");
    Party = require("../dist/controllers/party");
});
after(() => {
    Links.SetSlayerLinkOnlineCheck();
    for(const Key of ["HUNT_PASS_SEASONS_DIR", "ACTIVE_HUNT_PASS", "SEASONAL_EVENTS_FILE"]) delete process.env[Key];
    Context.Db.$client.close();
    Context.Cleanup();
    fs.rmSync(Dir, { recursive: true, force: true });
});

// Link XP counts only for gameserver awards, which carry the hunt context.
const HUNT = { world: "/Game/Maps/islands/test", copresentCharacterIds: [] };

// Two players linked, partied and online, as the link XP rule requires.
function LinkedPair(Name){
    const A = Harness.SeedAccount(Context, `${Name}A`), B = Harness.SeedAccount(Context, `${Name}B`);
    const LinkId = crypto.randomUUID();
    Context.Db.insert(Context.Schema.slayerlinks).values({ linkId: LinkId, senderId: A.UserId, targetId: B.UserId,
        senderSlot: 1, targetSlot: 1, createdAt: Date.now() - 1000, endsAt: Date.now() + 7 * 24 * 3600_000 }).run();
    Links.SetSlayerLinkOnlineCheck((Account) => Account === A.UserId || Account === B.UserId);
    Party.GetOrCreateParty(A.UserId, "test-build");
    Party.InviteToParty(A.UserId, B.UserId, "test-build");
    Party.AcceptPartyInvite(B.UserId, Party.GetInvitesForPlayer(B.UserId)[0].inviteId);
    const Progress = () => Context.Db.select().from(Context.Schema.slayerlinks).all().find((Row) => Row.linkId === LinkId).progress;
    const Done = () => { Party.LeaveParty(A.UserId); Party.LeaveParty(B.UserId); };
    return { A, Progress, Done };
}

test("XP on the chosen event pass advances the link", () => {
    const { A, Progress, Done } = LinkedPair("Event");
    Selection.SetSelectedHuntPassId(A.UserId, "eventpass_running");
    Writes.ApplyProgressAndObjectives(A.UserId, [{ progression_id: "eventpass_running", progress: 120 }], [], HUNT);
    assert.equal(Progress(), 120);
    Done();
});

test("XP on the main pass still advances the link while an event pass is chosen", () => {
    const { A, Progress, Done } = LinkedPair("Main");
    Selection.SetSelectedHuntPassId(A.UserId, "eventpass_running");
    Writes.ApplyProgressAndObjectives(A.UserId, [{ progression_id: "season_main", progress: 40 }], [], HUNT);
    assert.equal(Progress(), 40);
    Done();
});

test("an award naming both passes advances the link once", () => {
    const { A, Progress, Done } = LinkedPair("Both");
    Selection.SetSelectedHuntPassId(A.UserId, "eventpass_running");
    Writes.ApplyProgressAndObjectives(A.UserId, [
        { progression_id: "season_main", progress: 50 }, { progression_id: "eventpass_running", progress: 50 }], [], HUNT, "req-both");
    assert.equal(Progress(), 50);
    Done();
});

test("an event pass the player has not chosen does not advance the link", () => {
    const { A, Progress, Done } = LinkedPair("Unchosen");
    Writes.ApplyProgressAndObjectives(A.UserId, [{ progression_id: "eventpass_running", progress: 70 }], [], HUNT);
    assert.equal(Progress(), 0);
    Done();
});
