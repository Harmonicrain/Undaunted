"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { FindJoinableWorld } = require("../dist/controllers/joinWorld");

const World = (Port, HuntId, Extra = {}) => ({
    port: Port, isRamsgate: false, isTrainingDojo: false, processId: Port,
    expectedPlayers: [{ playerUid: "UID-a", playerHuntId: HuntId }], ...Extra
});
const Alive = () => true;

test("a running world of the same hunt on the requested port is joinable", () => {
    const Worlds = [World(8781, "ShatteredIsles_IslandA"), World(8782, "ShatteredIsles_IslandH")];
    assert.equal(FindJoinableWorld(Worlds, 8782, "ShatteredIsles_IslandH", Alive), Worlds[1]);
});

test("a world that ended, was reused for another hunt or is a hub is not joinable", () => {
    const Worlds = [World(8781, "ShatteredIsles_IslandA"), World(8789, "ShatteredIsles_IslandA", { isRamsgate: true }),
        World(8788, "ShatteredIsles_IslandA", { isTrainingDojo: true }), World(8783, "ShatteredIsles_IslandA", { expectedPlayers: undefined })];
    assert.equal(FindJoinableWorld(Worlds, 8781, "ShatteredIsles_IslandA", () => false), undefined);
    assert.equal(FindJoinableWorld(Worlds, 8781, "ShatteredIsles_IslandH", Alive), undefined);
    assert.equal(FindJoinableWorld(Worlds, 8789, "ShatteredIsles_IslandA", Alive), undefined);
    assert.equal(FindJoinableWorld(Worlds, 8788, "ShatteredIsles_IslandA", Alive), undefined);
    assert.equal(FindJoinableWorld(Worlds, 8783, "ShatteredIsles_IslandA", Alive), undefined);
    assert.equal(FindJoinableWorld(Worlds, 8790, "ShatteredIsles_IslandA", Alive), undefined);
    assert.equal(FindJoinableWorld(Worlds, "8781", "ShatteredIsles_IslandA", Alive), undefined);
    assert.equal(FindJoinableWorld(Worlds, undefined, "ShatteredIsles_IslandA", Alive), undefined);
});
