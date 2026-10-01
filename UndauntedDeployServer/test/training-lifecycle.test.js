"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const { promisify } = require("node:util");

function Fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "undaunted-training-lifecycle-"));
    const previousEnv = { ...process.env };
    Object.assign(process.env, {
        NODE_ENV: "production", LOG_LEVEL: "silent", PORT_RANGE_BEGIN: "8870", PORT_RANGE_END: "8879",
        GAMESERVER_BINARY_PATH: path.join(directory, "test-world.exe"), METAGAME_API_KEY: "test-only-key",
        MY_IP: "127.0.0.1", METAGAME_ADDRESS: "127.0.0.1:1", SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP: "0"
    });
    delete process.env.GAMESERVER_LOG_DIR;
    const children = [], live = new Map();
    t.mock.method(childProcess, "spawn", (_binary, args) => {
        const child = new EventEmitter();
        child.pid = 1_000_000 + children.length;
        child.args = args;
        child.exitCode = null;
        child.unref = () => {};
        child.kill = () => child.exit(1);
        child.exit = code => {
            live.delete(child.pid); child.exitCode = code;
            child.emit("exit", code, null);
        };
        children.push(child); live.set(child.pid, child);
        return child;
    });
    const originalExec = childProcess.execFile;
    const exec = (_command, _args, callback) => {
        callback(null, [...live.values()].map(child => `UDP 127.0.0.1:${child.args[1]} *:* ${child.pid}`).join("\n"), "");
    };
    // execFile's built-in promisify implementation otherwise calls the original
    // native function even when its callback form is mocked.
    exec[promisify.custom] = async () => ({
        stdout: [...live.values()].map(child => `UDP 127.0.0.1:${child.args[1]} *:* ${child.pid}`).join("\n"), stderr: ""
    });
    childProcess.execFile = exec;
    t.after(() => { childProcess.execFile = originalExec; });
    t.mock.method(process, "kill", pid => {
        if (!live.has(pid)) throw Object.assign(new Error("not running"), { code: "ESRCH" });
        return true;
    });
    for (const module of ["../dist/controllers/gameservers", "../dist/logger"]) delete require.cache[require.resolve(module)];
    const servers = require("../dist/controllers/gameservers");
    const lease = require("../dist/controllers/trainingLease");
    t.after(() => {
        for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
        Object.assign(process.env, previousEnv);
        assert.equal(path.dirname(directory), os.tmpdir());
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return { servers, children, live, lease, leasePath: child => lease.TrainingLeasePath(process.env.GAMESERVER_BINARY_PATH, child.pid) };
}

test("boot starts Ramsgate only; concurrent Training requests launch one ready world", async t => {
    const f = Fixture(t);
    await f.servers.Startup();
    assert.equal(f.children.length, 1);
    assert.match(f.children[0].args[2], /ramsgate/);
    const results = await Promise.all(Array.from({ length: 12 }, () => f.servers.GetTrainingDojoConnectionDetails()));
    assert.equal(f.children.length, 2);
    assert.ok(results.every(result => result.port === 8878));
    assert.ok(f.children[1].args.includes("-UndauntedTrainingIdleSeconds=300"));
    assert.equal(f.children[0].args.some(arg => arg.includes("TrainingIdle")), false);
});

test("idle exit remains asleep and the next request starts a new world", async t => {
    const f = Fixture(t);
    await f.servers.GetTrainingDojoConnectionDetails();
    const child = f.children[0];
    fs.writeFileSync(f.leasePath(child), "sleeping");
    child.exit(f.lease.TRAINING_IDLE_EXIT_CODE);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.children.length, 1);
    assert.equal(f.servers.Gameservers.length, 0);
    assert.equal(fs.existsSync(f.leasePath(child)), false);
    await f.servers.GetTrainingDojoConnectionDetails();
    assert.equal(f.children.length, 2);
});

test("watchdog cleanup before the exit event respects the sleeping marker", async t => {
    const f = Fixture(t);
    await f.servers.GetTrainingDojoConnectionDetails();
    const child = f.children[0], world = f.servers.Gameservers[0];
    fs.writeFileSync(f.leasePath(child), "sleeping");
    f.live.delete(child.pid);
    await f.servers.CleanupServer(world);
    child.exit(f.lease.TRAINING_IDLE_EXIT_CODE);
    assert.equal(f.children.length, 1);
    assert.equal(f.servers.Gameservers.length, 0);
    await f.servers.GetTrainingDojoConnectionDetails();
    assert.equal(f.children.length, 2);
});

test("unexpected Training exit still restarts it and coalesces a waiting request", async t => {
    const f = Fixture(t);
    await f.servers.GetTrainingDojoConnectionDetails();
    f.children[0].exit(1);
    await f.servers.GetTrainingDojoConnectionDetails();
    assert.equal(f.children.length, 2);
    assert.equal(f.servers.Gameservers.length, 1);
});
