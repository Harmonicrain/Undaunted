"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

let Server, Url;

before(async () => {
    const Keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.AUTH_SIGNING_PRIVKEY_B64 = Buffer.from(
        Keys.privateKey.export({ type: "pkcs8", format: "pem" })
    ).toString("base64");
    process.env.AUTH_SIGNING_PUBKEY_B64 = Buffer.from(
        Keys.publicKey.export({ type: "spki", format: "pem" })
    ).toString("base64");

    const express = require("express");
    const App = express();
    App.use(require("../dist/routes/client112").client112Router);
    Server = await new Promise((resolve) => {
        const Instance = App.listen(0, "127.0.0.1", () => resolve(Instance));
    });
    Url = `http://127.0.0.1:${Server.address().port}`;
});

after(async () => {
    if(Server !== undefined){
        await new Promise((resolve) => Server.close(resolve));
    }
});

test("daily challenges receive one automatic draft token at each UTC reset", async () => {
    const Response = await fetch(`${Url}/game_tuning/bounty_game_data_daily`);
    const Body = await Response.json();

    assert.equal(Response.status, 200);
    assert.equal(Body.payload.bounty_token_id, "TOKEN_DAILY_CHALLENGE_DRAFT");
    assert.equal(Body.payload.bounty_token_grant_hour, 0);
    assert.equal(Body.payload.num_tokens_hp_start, 1);
    assert.equal(Body.payload.num_tokens_per_day, 1);
    assert.equal(Body.payload.automatic_draft, true);
});
