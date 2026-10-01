"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ParseExtraWorldArgs } = require("../dist/controllers/worldArgs");

test("extra world args are split on whitespace and empty values are ignored", () => {
    assert.deepEqual(ParseExtraWorldArgs(undefined), []);
    assert.deepEqual(ParseExtraWorldArgs(""), []);
    assert.deepEqual(ParseExtraWorldArgs("   "), []);
    assert.deepEqual(ParseExtraWorldArgs("-UndauntedServerFPS=60"), ["-UndauntedServerFPS=60"]);
    assert.deepEqual(ParseExtraWorldArgs(" -UndauntedServerFPS=60\t-UndauntedIdleFPS=5 \r\n"),
        ["-UndauntedServerFPS=60", "-UndauntedIdleFPS=5"]);
});
