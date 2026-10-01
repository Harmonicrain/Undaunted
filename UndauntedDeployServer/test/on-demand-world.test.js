"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { OnDemandWorld } = require("../dist/controllers/onDemandWorld");

function Fixture(overrides = {}) {
    let now = 0, starts = 0;
    const options = {
        start: async () => ({ id: ++starts, alive: true, closing: false }),
        alive: world => world.alive,
        reserve: world => !world.closing,
        wait: async () => { now += 50; },
        now: () => now,
        ...overrides
    };
    return { world: new OnDemandWorld(options), starts: () => starts };
}

test("simultaneous cold travel requests share one launch and readiness result", async () => {
    let finish, launches = 0;
    const ready = new Promise(resolve => { finish = resolve; });
    const f = Fixture({ start: () => { launches++; return ready; } });
    const first = f.world.get(), second = f.world.get();
    assert.equal(first, second);
    assert.equal(launches, 1);
    const running = { alive: true };
    finish(running);
    assert.equal(await first, running);
    assert.equal(await second, running);
});

test("a failed cold launch is shared and a later request can retry", async () => {
    let attempts = 0;
    const f = Fixture({ start: async () => { if (++attempts === 1) throw new Error("boot failed"); return { alive: true }; } });
    const first = f.world.get(), second = f.world.get();
    await Promise.all([assert.rejects(first, /boot failed/), assert.rejects(second, /boot failed/)]);
    assert.equal((await f.world.get()).alive, true);
    assert.equal(attempts, 2);
});

test("a travel request racing idle exit waits for a replacement, never returns the old port", async () => {
    let closing;
    const f = Fixture({ wait: async () => { closing.alive = false; } });
    closing = await f.world.get();
    closing.closing = true;
    const replacement = await f.world.get();
    assert.notEqual(replacement, closing);
    assert.equal(f.starts(), 2);
});

test("late cleanup of an old world cannot forget its replacement", async () => {
    const f = Fixture();
    const old = await f.world.get(); old.alive = false;
    const replacement = await f.world.get();
    f.world.forget(old);
    assert.equal(await f.world.get(), replacement);
    assert.equal(f.starts(), 2);
});

test("a permanently locked reservation fails within a bounded wait", async () => {
    const f = Fixture({ reserve: () => false });
    await assert.rejects(f.world.get(), /did not accept a travel reservation/);
    assert.equal(f.starts(), 1);
});
