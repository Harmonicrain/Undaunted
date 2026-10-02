"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PortPool } = require("../dist/controllers/portPool");
const { OnDemandWorld } = require("../dist/controllers/onDemandWorld");

function Pool(...ports) {
    const pool = new PortPool();
    for (const port of ports) pool.add(port);
    return pool;
}

test("a world that exits during startup and then fails readiness frees its port once", () => {
    const pool = Pool(8780, 8781, 8782);
    const port = pool.take();
    assert.equal(pool.release(port), true);   // exit handler
    assert.equal(pool.release(port), false);  // failed startup
    const next = [pool.take(), pool.take(), pool.take()];
    assert.equal(new Set(next).size, 3);
    assert.equal(pool.take(), undefined);
});

test("ports that are free or held cannot be added twice", () => {
    const pool = Pool(8780, 8780);
    assert.equal(pool.freeCount, 1);
    const port = pool.take();
    pool.add(port);
    assert.equal(pool.freeCount, 0);
});

test("a port that was never taken is not released into the pool", () => {
    const pool = Pool(8780);
    assert.equal(pool.release(9999), false);
    assert.equal(pool.freeCount, 1);
});

test("concurrent requests for a dead persistent world share one restart", async () => {
    let starts = 0, finish;
    const first = { alive: false };
    const world = new OnDemandWorld({
        start: () => { starts++; return starts === 1 ? Promise.resolve(first) : new Promise(resolve => { finish = resolve; }); },
        alive: w => w.alive,
        reserve: () => true,
        wait: async () => {},
        now: () => 0
    });
    first.alive = true;
    assert.equal(await world.get(), first);
    first.alive = false;   // it crashed
    const requests = [world.get(), world.get(), world.get()];
    const replacement = { alive: true };
    finish(replacement);
    for (const request of requests) assert.equal(await request, replacement);
    assert.equal(starts, 2);
});
