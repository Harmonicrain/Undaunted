"use strict";
// Every player hunt in the loaded tables resolves to a world. With
// HUNT_DATA_DIR set this checks the tables built for a client
// (tools/Build-Hunts112.mjs for 1.12.0); unset, the bundled 1.4.4 ones.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PlayerHunts, MatchmakerHunts, TrialsHunts } = require("../dist/controllers/huntTables");
const { ResolveHuntLaunch } = require("../dist/controllers/gameservers");

test("every player hunt with a matchmaker hunt resolves to a map and a behemoth", () => {
    let Resolved = 0;
    for(const HuntId of Object.keys(PlayerHunts)){
        // The old expedition islands name only empty "None" slots.
        const Playable = HuntId.includes("Arena") || PlayerHunts[HuntId].MatchmakerHuntIDs.some((Entry) => Entry.RowName in MatchmakerHunts);
        if(!Playable) continue;
        const Launch = ResolveHuntLaunch(HuntId);
        assert.match(Launch.MapPath, /^\/Game\/Maps\//, HuntId);
        assert.match(Launch.BehemothPath, /^(\/Game\/|None$)/, HuntId);
        Resolved++;
    }
    assert.ok(Resolved > 100, `${Resolved} hunts resolved`);
});

test("trials draw a numbered trial of the hunt's own difficulty, never a test row", () => {
    const EasyTable = TrialsHunts.Easy === TrialsHunts.Hard ? "Hard" : "Easy";
    for(const [HuntId, Difficulty] of [["CR19_PlayerHunt_Arena_Hard", "Hard"], ["CR19_PlayerHunt_Arena_Elite", "Elite"], ["CR19_PlayerHunt_Arena_Easy", EasyTable]]){
        for(let i = 0; i < 200; i++){
            const Launch = ResolveHuntLaunch(HuntId);
            assert.match(Launch.MatchmakerHuntId, new RegExp(`^Arena_MatchmakerHunt_${Difficulty}_\\d+$`));
            assert.match(Launch.BehemothPath, /^\/Game\//);
        }
    }
});

test("the 1.12.0 islands launch as exploration worlds", { skip: !("ShatteredIsles_IslandU" in PlayerHunts) && "tables without 1.12.0 islands" }, () => {
    const Launch = ResolveHuntLaunch("ShatteredIsles_IslandU");
    assert.equal(Launch.MatchmakerHuntId, "Adventure_IslandU");
    assert.match(Launch.MapPath, /adventure_tundra_jamima\?game=\/Game\/Blueprints\/GameMode\/BPGM_ArchonExploration\.BPGM_ArchonExploration_C$/);
    assert.equal(Launch.BehemothPath, "None");
});

test("an unknown hunt is refused by name", () => {
    assert.throws(() => ResolveHuntLaunch("PlayerHunt_DoesNotExist"), /Unknown player hunt PlayerHunt_DoesNotExist/);
});
