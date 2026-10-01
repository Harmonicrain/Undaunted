"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const lease = require("../dist/controllers/trainingLease");

function Fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "undaunted-training-lease-"));
    t.after(() => {
        assert.equal(path.dirname(directory), os.tmpdir());
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return path.join(directory, "world.lease");
}

test("travel renews the reservation without shortening an existing lease", t => {
    const file = Fixture(t), now = 1_800_000_000_000;
    lease.CreateTrainingLease(file, now);
    assert.ok(lease.ReserveTrainingLease(file, now + 30_000));
    assert.equal(Number(fs.readFileSync(file, "utf8")), now + 150_000);
    assert.ok(lease.ReserveTrainingLease(file, now));
    assert.equal(Number(fs.readFileSync(file, "utf8")), now + 150_000);
});

test("missing, malformed and sleeping leases cannot advertise a world for travel", t => {
    const file = Fixture(t);
    assert.equal(lease.ReserveTrainingLease(file), false);
    for (const contents of ["garbage", "sleeping", ""]) {
        fs.writeFileSync(file, contents);
        assert.equal(lease.ReserveTrainingLease(file), false);
        assert.equal(fs.readFileSync(file, "utf8"), contents);
    }
    fs.writeFileSync(file, "sleeping");
    assert.equal(lease.TrainingSleepMarked(file), true);
    lease.RemoveTrainingLease(file);
    lease.RemoveTrainingLease(file);
    assert.equal(lease.TrainingSleepMarked(file), false);
});

// PowerShell takes 3-8 s to start on GitHub's Windows runners (10.1 s once).
test("an exclusive native-style Windows handle blocks renewal until release", { skip: process.platform !== "win32", timeout: 60000 }, async t => {
    const file = Fixture(t);
    lease.CreateTrainingLease(file);
    const quoted = file.replaceAll("'", "''");
    const helper = spawn("powershell.exe", ["-NoProfile", "-Command",
        `$handle=[IO.File]::Open('${quoted}', 'Open', 'ReadWrite', 'None'); Write-Output 'locked'; Start-Sleep -Milliseconds 600; $handle.Dispose()`],
        { windowsHide: true });
    t.after(() => { if (helper.exitCode === null) helper.kill(); });
    const exited = once(helper, "exit");
    await once(helper.stdout, "data");
    assert.equal(lease.ReserveTrainingLease(file), false);
    assert.equal((await exited)[0], 0);
    assert.equal(lease.ReserveTrainingLease(file), true);
});
