"use strict";

// Slayer Link lifecycle, prize pools, collection and link XP against a
// disposable database. Time is injected: nothing here waits seven days or
// touches a real link.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Harness = require("./harness");

let Context, Db, Schema, Server, Base, Sign, Links, LinkConfig, Repairs, Writes, Config, Party;
const GameKey = crypto.randomBytes(32).toString("hex");
const DAY = 24 * 3600_000;
let Clock = Date.UTC(2026, 0, 1);

const POOL = [
    { catalog_id: "CURRENCY_NOTES", quantity: 1000, received_for_level: 1 },
    { catalog_id: "ORB_FLAME", quantity: 20, received_for_level: 2 },
    { catalog_id: "CURRENCY_PRESTIGE", quantity: 50, received_for_level: 3 },
    { catalog_id: "AC_HEAD_CROWN", quantity: 1, received_for_level: 4 },
    { catalog_id: "GEM_ALPHA", quantity: 10, received_for_level: 0 }
];
const OTHER_POOL = [
    { catalog_id: "TOKEN_BOUNTY_DRAFT", quantity: 2, received_for_level: 1 },
    { catalog_id: "GEM_HEROIC", quantity: 5, received_for_level: 2 }
];

before(async () => {
    const Keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.AUTH_SIGNING_PRIVKEY_B64 = Buffer.from(Keys.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
    process.env.AUTH_SIGNING_PUBKEY_B64 = Buffer.from(Keys.publicKey.export({ type: "spki", format: "pem" })).toString("base64");
    Context = Harness.CreateDisposableDatabase();
    Db = Context.Db; Schema = Context.Schema;
    Sign = require("../dist/controllers/auth").SignMetagameJWTForUid;
    Links = require("../dist/controllers/slayerLinks");
    LinkConfig = require("../dist/controllers/slayerLinkConfig");
    Repairs = require("../dist/db/repairs");
    Writes = require("../dist/controllers/progressionWrites");
    Config = require("../dist/controllers/huntpass");
    Party = require("../dist/controllers/party");
    Links.SetSlayerLinkClock(() => Clock);
    Db.insert(Schema.gameserverapikeys).values({ keyHash: crypto.createHash("sha256").update(GameKey).digest("hex") }).run();
    const App = require("express")();
    App.use(require("express").json());
    App.use(require("../dist/routes/friends").friendsRouter);
    App.use(require("../dist/routes/slayerLinks").slayerLinksRouter);
    App.use(require("../dist/routes/progression").progressionRouter);
    App.use(require("../dist/routes/inventory").inventoryRouter);
    Server = await new Promise(resolve => { const S = App.listen(0, "127.0.0.1", () => resolve(S)); });
    Base = `http://127.0.0.1:${Server.address().port}`;
});
after(async () => {
    Links.SetSlayerLinkClock();
    await new Promise(resolve => Server.close(resolve));
    Db.$client.close();
    Context.Cleanup();
});
beforeEach(() => { Clock = Date.UTC(2026, 0, 1); });

async function Call(Path, { account, gameserver = false, method = "GET", body, headers = {} } = {}) {
    const Response = await fetch(Base + Path, { method, headers: {
        "content-type": "application/json",
        ...(account ? { authorization: `bearer ${Sign(account.UserId)}` } : {}),
        ...(gameserver ? { "x-undaunted-gameserver-apikey": GameKey } : {}),
        ...headers
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const Text = await Response.text();
    return { status: Response.status, json: Text ? JSON.parse(Text) : undefined };
}
function Player(Name) { return Harness.SeedAccount(Context, Name); }
async function Befriend(A, B) {
    await Call(`/friends/api/public/friends/${A.UserId}/${B.UserId}`, { account: A, method: "POST" });
    await Call(`/friends/api/public/friends/${B.UserId}/${A.UserId}`, { account: B, method: "POST" });
}
async function Link(A, B, SlotA = 1, SlotB) {
    await Befriend(A, B);
    const Invite = await Call("/slayerlink/invite", { account: A, method: "PUT", body: { account_id: B.UserId, slot: SlotA, action_source: "social_panel" } });
    assert.equal(Invite.status, 200, JSON.stringify(Invite.json));
    const Accept = await Call("/slayerlink/invite", { account: B, method: "POST",
        body: { account_id: A.UserId, action: "accept", ...(SlotB === undefined ? {} : { slot: SlotB }), action_source: "social_panel" } });
    assert.equal(Accept.status, 200, JSON.stringify(Accept.json));
    return Accept.json.payload.link_id;
}
async function ListLinks(A) { return (await Call("/slayerlink/links", { account: A })).json.payload.links; }
function StorePool(A, Slot, Pool = POOL, extra = {}) {
    return Call("/slayerlink/links/rewards", { gameserver: true, method: "PUT", body: [{ account_id: A.UserId, slot: Slot, prize_pool: Pool }], ...extra });
}
function Rewards(A, Slot) { return Call(`/slayerlink/links/rewards/${A.UserId}/${Slot}`, { gameserver: true }); }
function Grant(A, Items, TransactionId = crypto.randomUUID()) {
    return Call("/inventory", { gameserver: true, method: "POST", body: {
        accountId: A.UserId, characterId: A.CharacterId, source: "SlayerLinks.GrantRewards", transactionId: TransactionId,
        addStackedItems: Items.filter(I => I.catalog_id !== "AC_HEAD_CROWN").map(I => ({ catalogId: I.catalog_id, quantity: I.quantity })),
        addInstancedItems: Items.filter(I => I.catalog_id === "AC_HEAD_CROWN").map(() => ({ catalogId: "AC_HEAD_CROWN", instanceId: crypto.randomUUID(), updateVersion: 0 })),
        removeStackedItems: [], removeInstancedItems: [], saveInstancedItems: [] } });
}
function SetProgress(LinkId, Progress) {
    const { eq } = require("drizzle-orm");
    Db.update(Schema.slayerlinks).set({ progress: Progress }).where(eq(Schema.slayerlinks.linkId, LinkId)).run();
}
function LinkRow(LinkId) {
    const { eq } = require("drizzle-orm");
    return Db.select().from(Schema.slayerlinks).where(eq(Schema.slayerlinks.linkId, LinkId)).get();
}
function Wallet(A, Currency) {
    return Db.select().from(Schema.wallets).all().find(R => R.userId === A.UserId && R.currencyId === Currency)?.amount ?? 0;
}
function HuntHeaders(...Players) { return { "x-undaunted-world": "/Game/Maps/islands/1705/dia_moss_triforce", "x-undaunted-copresent": Players.map(P => P.CharacterId).join(",") }; }
const HuntPass = () => Config.GetActiveHuntPassId();
// Puts the players in one party with every member online; returns the undo.
function Partied(...Players) {
    const Ids = Players.map(P => P.UserId);
    Links.SetSlayerLinkOnlineCheck(Account => Ids.includes(Account));
    Party.GetOrCreateParty(Ids[0], "test-build");
    for (const Id of Ids.slice(1)) {
        Party.InviteToParty(Ids[0], Id, "test-build");
        Party.AcceptPartyInvite(Id, Party.GetInvitesForPlayer(Id)[0].inviteId);
    }
    return () => { for (const Id of Ids) Party.LeaveParty(Id); Links.SetSlayerLinkOnlineCheck(); };
}

test("slots are 1..3 everywhere; 0 and 4 are refused", async () => {
    const A = Player("SlotA"), B = Player("SlotB");
    await Befriend(A, B);
    for (const Slot of [0, 4, -1, 1.5]) {
        assert.equal((await Call("/slayerlink/invite", { account: A, method: "PUT", body: { account_id: B.UserId, slot: Slot } })).status, 400);
    }
    await Call("/slayerlink/invite", { account: A, method: "PUT", body: { account_id: B.UserId, slot: 3 } });
    for (const Slot of [0, 4]) {
        assert.equal((await Call("/slayerlink/invite", { account: B, method: "POST", body: { account_id: A.UserId, action: "accept", slot: Slot } })).status, 400);
    }
    assert.equal((await Call("/slayerlink/invite", { account: B, method: "POST", body: { account_id: A.UserId, action: "accept", slot: 2 } })).status, 200);
    assert.deepEqual((await ListLinks(A)).map(L => L.slot), [3]);
    assert.deepEqual((await ListLinks(B)).map(L => L.slot), [2]);
    assert.equal((await Rewards(A, 0)).status, 400);
    assert.equal((await Rewards(A, 4)).status, 400);
    assert.equal((await Call("/slayerlink/links", { gameserver: true, method: "DELETE", body: { links: [{ account_id: A.UserId, slot: 0, delete_pair: true }] } })).status, 400);
});

test("acceptance uses the recipient's chosen slot, retries are idempotent and outsiders are refused", async () => {
    const A = Player("AccA"), B = Player("AccB"), C = Player("AccC"), D = Player("AccD");
    await Befriend(A, B); await Befriend(C, B); await Befriend(D, B);
    await Link(C, B, 1, 1);
    await Call("/slayerlink/invite", { account: A, method: "PUT", body: { account_id: B.UserId, slot: 2 } });
    // Outsider cannot accept; stale choice of an occupied slot is refused.
    assert.equal((await Call("/slayerlink/invite", { account: D, method: "POST", body: { account_id: A.UserId, action: "accept", slot: 2 } })).status, 404);
    assert.equal((await Call("/slayerlink/invite", { account: B, method: "POST", body: { account_id: A.UserId, action: "accept", slot: 1 } })).status, 409);
    assert.equal((await Call("/slayerlink/invite", { account: B, method: "POST", body: { account_id: A.UserId, action: "accept", slot: 3 } })).status, 200);
    assert.equal((await Call("/slayerlink/invite", { account: B, method: "POST", body: { account_id: A.UserId, action: "accept", slot: 3 } })).status, 200);
    const Rows = Db.select().from(Schema.slayerlinks).all().filter(R => R.senderId === A.UserId);
    assert.equal(Rows.length, 1);
    const Mine = await ListLinks(B);
    assert.deepEqual(Mine.map(L => [L.account_id, L.slot]).sort(), [[A.UserId, 3], [C.UserId, 1]].sort());
    const Theirs = await ListLinks(A);
    assert.deepEqual(Theirs, [{ link_id: Rows[0].linkId, account_id: B.UserId, slot: 2, ends: new Date(Clock + 7 * DAY).toISOString(), prize_pool: [] }]);
    // A second link to the same partner is refused while the first is listed.
    assert.equal((await Call("/slayerlink/invite", { account: A, method: "PUT", body: { account_id: B.UserId, slot: 1 } })).status, 409);
    // Omitted slot takes the lowest free one.
    const E = Player("AccE"), F = Player("AccF");
    await Link(E, F);
    assert.equal((await ListLinks(F))[0].slot, 1);
    // A player cannot delete someone else's link by naming them.
    assert.equal((await Call("/slayerlink/links", { account: D, method: "DELETE", body: { links: [{ account_id: A.UserId, slot: 2, delete_pair: true }] } })).status, 403);
    assert.equal((await ListLinks(A)).length, 1);
});

test("legacy zero-based slots are repaired in place, idempotently and around collisions", () => {
    const Insert = (LinkId, Sender, Target, SenderSlot, TargetSlot, Progress = 0) => Db.insert(Schema.slayerlinks).values({
        linkId: LinkId, senderId: Sender, targetId: Target, senderSlot: SenderSlot, targetSlot: TargetSlot,
        createdAt: 1790122159719, endsAt: 1790726959719, progress: Progress }).run();
    const John = Player("LegacyJohn"), Manda = Player("LegacyManda"), Busy = Player("LegacyBusy"), Other = Player("LegacyOther");
    Insert("legacy-1", John.UserId, Manda.UserId, 1, 0, 37);
    // Busy already holds slot 1, so its invalid side must move to 2.
    Insert("legacy-busy-ok", Other.UserId, Busy.UserId, 2, 1);
    Insert("legacy-busy", John.UserId, Busy.UserId, 2, 0);
    const Before = LinkRow("legacy-1");
    const Log = [];
    const Repaired = Repairs.RepairLegacySlayerLinkSlots(Db.$client, M => Log.push(M));
    assert.deepEqual(Repaired.map(R => [R.linkId, R.to]).sort(), [["legacy-1", 1], ["legacy-busy", 2]]);
    const After = LinkRow("legacy-1");
    assert.deepEqual({ ...After, targetSlot: 0 }, { ...Before, targetSlot: 0 });
    assert.equal(After.targetSlot, 1);
    assert.equal(After.senderSlot, 1);
    assert.equal(After.progress, 37);
    assert.equal(LinkRow("legacy-busy").targetSlot, 2);
    assert.deepEqual(Repairs.RepairLegacySlayerLinkSlots(Db.$client), []);
    // No free slot: left untouched, never deleted.
    const Full = Player("LegacyFull"), P = [Player("P1"), Player("P2"), Player("P3"), Player("P4")];
    P.slice(0, 3).forEach((X, I) => Insert(`full-${I}`, X.UserId, Full.UserId, 1, I + 1));
    Insert("full-bad", P[3].UserId, Full.UserId, 1, 0);
    assert.deepEqual(Repairs.RepairLegacySlayerLinkSlots(Db.$client), []);
    assert.equal(LinkRow("full-bad").targetSlot, 0);
});

test("prize pools: gameserver only, validated, identical retries accepted, rerolls and invalid catalogue refused, batches atomic", async () => {
    const A = Player("PoolA"), B = Player("PoolB");
    await Link(A, B, 1, 1);
    assert.equal((await Call("/slayerlink/links/rewards", { account: A, method: "PUT", body: [{ account_id: A.UserId, slot: 1, prize_pool: POOL }] })).status, 403);
    assert.equal((await StorePool(A, 1, [{ catalog_id: "CURRENCY_PLATINUM", quantity: 1000, received_for_level: 1 }])).status, 400);
    assert.equal((await StorePool(A, 1, [{ catalog_id: "CURRENCY_NOTES", quantity: 999999, received_for_level: 1 }])).status, 400);
    assert.equal((await StorePool(A, 1, [{ catalog_id: "CURRENCY_NOTES", quantity: 1000, received_for_level: 7 }])).status, 400);
    assert.equal((await StorePool(A, 1, [{ catalog_id: "CURRENCY_NOTES", quantity: 1000, received_for_level: -2 }])).status, 400);
    assert.equal((await StorePool(A, 1, [{ catalog_id: "CURRENCY_NOTES", quantity: 1000, received_for_level: 2 }, { catalog_id: "ORB_FLAME", quantity: 20, received_for_level: 2 }])).status, 400);
    assert.equal((await StorePool(A, 2)).status, 404);
    // Atomic: an invalid second entry stores nothing.
    const Mixed = await Call("/slayerlink/links/rewards", { gameserver: true, method: "PUT", body: [
        { account_id: A.UserId, slot: 1, prize_pool: POOL }, { account_id: B.UserId, slot: 1, prize_pool: [{ catalog_id: "NOPE", quantity: 1, received_for_level: 1 }] }] });
    assert.equal(Mixed.status, 400);
    assert.deepEqual((await ListLinks(A))[0].prize_pool, []);
    assert.equal((await StorePool(A, 1)).status, 200);
    assert.equal((await StorePool(A, 1)).status, 200);
    assert.equal((await StorePool(A, 1, OTHER_POOL)).status, 409);
    assert.equal(Db.select().from(Schema.slayerlinkpools).all().filter(R => R.userId === A.UserId).length, 1);
    assert.deepEqual((await ListLinks(A))[0].prize_pool, POOL);
    assert.deepEqual((await ListLinks(B))[0].prize_pool, []);
    // The {links:[...]} wrapper is accepted too.
    assert.equal((await Call("/slayerlink/links/rewards", { gameserver: true, method: "PUT", body: { links: [{ account_id: B.UserId, slot: 1, prize_pool: OTHER_POOL }] } })).status, 200);
    assert.deepEqual((await ListLinks(B))[0].prize_pool, OTHER_POOL);
});

test("link tracks: config is incremental, thresholds 5/405/1205/2805, reads follow the link in the slot", async () => {
    const Paths = Config.GetProgressionConfigPayload().payload.paths.filter(P => P.progression_id.startsWith("Linked_Slayer_Slot_"));
    assert.deepEqual(Paths.map(P => P.progression_id), ["Linked_Slayer_Slot_1", "Linked_Slayer_Slot_2", "Linked_Slayer_Slot_3"]);
    assert.deepEqual(Paths[0].requirements.map(R => R.xp_required), [0, 5, 400, 800, 1600]);
    for (const [Points, Rank] of [[0, 0], [4, 0], [5, 1], [404, 1], [405, 2], [1204, 2], [1205, 3], [2804, 3], [2805, 4], [99999, 4]]) {
        assert.equal(LinkConfig.DeriveLinkRank(Points), Rank, `points ${Points}`);
        assert.equal(Config.DeriveRank("Linked_Slayer_Slot_2", Points).rank, Rank, `config points ${Points}`);
    }
    const A = Player("TrackA"), B = Player("TrackB");
    const Id = await Link(A, B, 2, 3);
    SetProgress(Id, 405);
    const Read = (await Call(`/progression/${A.UserId}/Linked_Slayer_Slot_2`, { account: A })).json.payload;
    assert.equal(Read.progress, 405);
    assert.equal(Read.progression_id, "Linked_Slayer_Slot_2");
    assert.equal((await Call(`/progression/${B.UserId}/Linked_Slayer_Slot_3`, { account: B })).json.payload.progress, 405);
    assert.equal((await Call(`/progression/${A.UserId}/Linked_Slayer_Slot_1`, { account: A })).json.payload.progress, 0);
    // Confirmation never runs ahead of the chests reached and grants nothing.
    const Confirm = await Call(`/progression/${A.UserId}/Linked_Slayer_Slot_2/4/confirm/public`, { gameserver: true, method: "POST" });
    assert.equal(Confirm.status, 200);
    assert.equal(Confirm.json.payload.confirmed_fremium_rank, 2);
    assert.equal((await Call(`/progression/${A.UserId}/Linked_Slayer_Slot_2`, { gameserver: true, method: "DELETE" })).status, 409);
    // Nothing leaks into the generic progression table.
    assert.equal(Db.select().from(Schema.progression).all().filter(R => R.trackId.startsWith("Linked_Slayer")).length, 0);
});

test("link XP: any Hunt Pass XP earned while partied with the online linked partner counts, shared by both, once per award", async () => {
    const A = Player("XpA"), B = Player("XpB"), C = Player("XpC");
    const Id = await Link(A, B, 1, 1);
    const Online = new Set([A.UserId, B.UserId, C.UserId]);
    Links.SetSlayerLinkOnlineCheck(Account => Online.has(Account));
    const Award = (Who, Amount, Headers, gameserver = true) =>
        Call(`/progression/${Who.UserId}/${HuntPass()}/${Amount}`, { gameserver, account: gameserver ? undefined : Who, method: "POST", headers: Headers });
    const Ramsgate = (...Players) => ({ "x-undaunted-world": "/Game/Maps/ramsgate/ramsgate_01_persistent", "x-undaunted-copresent": Players.map(P => P.CharacterId).join(",") });
    // Not partied: hunting in the same instance is not enough.
    await Award(A, 100, HuntHeaders(A, B));
    assert.equal(LinkRow(Id).progress, 0);
    Party.GetOrCreateParty(A.UserId, "test-build");
    Party.InviteToParty(A.UserId, B.UserId, "test-build");
    Party.AcceptPartyInvite(B.UserId, Party.GetInvitesForPlayer(B.UserId)[0].inviteId);
    assert.equal((await Award(A, 100, HuntHeaders(A, B))).status, 200);
    assert.equal(LinkRow(Id).progress, 100);
    // Partner contributes to the same shared total.
    await Award(B, 50, HuntHeaders(A, B));
    assert.equal(LinkRow(Id).progress, 150);
    // Bounty XP is paid in Ramsgate after the party returns; it counts too.
    await Award(A, 20, Ramsgate(A));
    assert.equal(LinkRow(Id).progress, 170);
    // Ineligible: partner offline, no gameserver context, forged by a player.
    Online.delete(B.UserId);
    await Award(A, 100, HuntHeaders(A, B));
    Online.add(B.UserId);
    await Award(A, 100, {});
    assert.equal((await Award(A, 100, HuntHeaders(A, B), false)).status, 403);
    assert.equal(LinkRow(Id).progress, 170);
    // Direct link-track grants are ignored rather than doubling progress.
    await Call(`/progression/${A.UserId}/Linked_Slayer_Slot_1/500`, { gameserver: true, method: "POST" });
    await Call(`/progression/${A.UserId}`, { gameserver: true, method: "POST", body: { progress_tracks: [{ progression_id: "Linked_Slayer_Slot_1", progress: 500 }], objectives: [] } });
    assert.equal(LinkRow(Id).progress, 170);
    // Bulk grants follow the same rule.
    await Call(`/progression/${A.UserId}`, { gameserver: true, method: "POST", headers: HuntHeaders(A, B),
        body: { progress_tracks: [{ progression_id: HuntPass(), progress: 5 }], objectives: [] } });
    assert.equal(LinkRow(Id).progress, 175);
    // The same source award applies once per link.
    Db.transaction(tx => Links.ApplyHuntPassXpToLinks(tx, A.UserId, 10, { world: "islands/x" }, "event-1"));
    Db.transaction(tx => Links.ApplyHuntPassXpToLinks(tx, A.UserId, 10, { world: "islands/x" }, "event-1"));
    assert.equal(LinkRow(Id).progress, 185);
    assert.equal(Db.select().from(Schema.slayerlinkxp).all().filter(R => R.linkId === Id).length, 5);
    // After the partner leaves the party, nothing more is shared.
    Party.LeaveParty(B.UserId);
    await Award(A, 100, HuntHeaders(A, B));
    assert.equal(LinkRow(Id).progress, 185);
    // Nothing is earned after the link ends.
    Party.InviteToParty(A.UserId, B.UserId, "test-build");
    Party.AcceptPartyInvite(B.UserId, Party.GetInvitesForPlayer(B.UserId)[0].inviteId);
    Clock += 7 * DAY;
    await Award(A, 100, HuntHeaders(A, B));
    assert.equal(LinkRow(Id).progress, 185);
    Party.LeaveParty(A.UserId); Party.LeaveParty(B.UserId);
    Links.SetSlayerLinkOnlineCheck();
});

test("cancellation is allowed at zero XP for both players and refused once XP is earned", async () => {
    const A = Player("CanA"), B = Player("CanB"), C = Player("CanC");
    const Id = await Link(A, B, 1, 1);
    const Zero = await Call("/slayerlink/links", { gameserver: true, method: "DELETE", body: { links: [{ account_id: B.UserId, slot: 1, delete_pair: true }] } });
    assert.equal(Zero.status, 200);
    assert.equal(Zero.json.payload.links[0].result, "canceled");
    assert.ok(LinkRow(Id).canceledAt);
    assert.deepEqual(await ListLinks(A), []);
    assert.deepEqual(await ListLinks(B), []);
    // The slots are free again.
    const Next = await Link(A, C, 1, 1);
    SetProgress(Next, 1);
    const Positive = await Call("/slayerlink/links", { gameserver: true, method: "DELETE", body: { links: [{ account_id: A.UserId, slot: 1, delete_pair: true }] } });
    assert.equal(Positive.status, 409);
    assert.equal((await Call("/slayerlink/link", { account: A, method: "DELETE", body: { slot: 1 } })).status, 409);
    assert.equal((await ListLinks(A)).length, 1);
    // Delete-everything is not a supported operation.
    assert.equal((await Call("/slayerlink/links", { gameserver: true, method: "DELETE" })).status, 400);
});

test("collection: hidden before expiry, each participant claims only their own rewards, exactly once", async () => {
    const A = Player("ColA"), B = Player("ColB");
    const Id = await Link(A, B, 1, 2);
    await StorePool(A, 1);
    await StorePool(B, 2, OTHER_POOL);
    SetProgress(Id, 1205);
    // Early collection is refused and the list keeps the link.
    assert.equal((await Rewards(A, 1)).status, 409);
    assert.equal((await Grant(A, POOL.slice(0, 3))).status, 409);
    Clock += 7 * DAY;
    const Listed = await ListLinks(A);
    assert.equal(Listed.length, 1, "expired links stay listed for collection");
    // A player cannot read someone else's rewards; the gameserver can.
    assert.equal((await Call(`/slayerlink/links/rewards/${A.UserId}/1`, { account: B })).status, 403);
    const Earned = (await Rewards(A, 1)).json.payload;
    assert.equal(Earned.is_service_granting, false);
    assert.deepEqual(Earned.rewards, POOL.slice(0, 3));
    // Reading does not consume anything.
    assert.deepEqual((await Rewards(A, 1)).json.payload.rewards, POOL.slice(0, 3));
    // Unclaimed rewards block releasing the side.
    assert.equal((await Call("/slayerlink/links", { gameserver: true, method: "DELETE", body: { links: [{ account_id: A.UserId, slot: 1, delete_pair: false }] } })).status, 409);
    // Wrong items do not claim.
    assert.equal((await Grant(A, [{ catalog_id: "CURRENCY_NOTES", quantity: 3000 }])).status, 409);
    // A grant for someone else's rewards does not match.
    assert.equal((await Grant(A, OTHER_POOL)).status, 409);
    const Tx = crypto.randomUUID();
    const First = await Grant(A, Earned.rewards, Tx);
    assert.equal(First.status, 200);
    assert.equal(Harness.StackedQuantity(Harness.ReadInventory(Context, A.CharacterId), "CURRENCY_NOTES"), 1000);
    assert.equal(Harness.StackedQuantity(Harness.ReadInventory(Context, A.CharacterId), "ORB_FLAME"), 20);
    assert.equal(Wallet(A, "CURRENCY_PRESTIGE"), 50);
    // Response lost: same transaction retried replays without granting.
    assert.equal((await Grant(A, Earned.rewards, Tx)).status, 200);
    // Repeated collection with a new transaction grants nothing.
    const Again = await Grant(A, Earned.rewards);
    assert.equal(Again.status, 200);
    assert.equal(Harness.StackedQuantity(Harness.ReadInventory(Context, A.CharacterId), "CURRENCY_NOTES"), 1000);
    assert.equal(Wallet(A, "CURRENCY_PRESTIGE"), 50);
    assert.deepEqual((await Rewards(A, 1)).json.payload.rewards, []);
    // Partner untouched by A's claim.
    assert.deepEqual((await Rewards(B, 2)).json.payload.rewards, OTHER_POOL);
    // Native deletion after completion releases only A's side.
    const Release = await Call("/slayerlink/links", { gameserver: true, method: "DELETE", body: { links: [{ account_id: A.UserId, slot: 1, delete_pair: true }] } });
    assert.equal(Release.status, 200);
    assert.equal(Release.json.payload.links[0].result, "released");
    assert.deepEqual(await ListLinks(A), []);
    assert.equal((await ListLinks(B)).length, 1);
    assert.deepEqual((await Rewards(B, 2)).json.payload.rewards, OTHER_POOL);
    assert.equal((await Grant(B, OTHER_POOL)).status, 200);
    assert.equal(Harness.StackedQuantity(Harness.ReadInventory(Context, B.CharacterId), "TOKEN_BOUNTY_DRAFT"), 2);
    assert.equal((await Call("/slayerlink/links", { gameserver: true, method: "DELETE", body: { links: [{ account_id: B.UserId, slot: 2, delete_pair: false }] } })).status, 200);
    assert.deepEqual(await ListLinks(B), []);
});

test("a failed inventory grant records no claim and can be retried", async () => {
    const A = Player("FailA"), B = Player("FailB");
    const Id = await Link(A, B, 1, 1);
    await StorePool(A, 1);
    SetProgress(Id, 2805);
    Clock += 7 * DAY + 1;
    const Earned = (await Rewards(A, 1)).json.payload.rewards;
    assert.deepEqual(Earned, POOL.slice(0, 4));
    // Wrong character: refused before anything is written.
    const Wrong = await Call("/inventory", { gameserver: true, method: "POST", body: {
        accountId: A.UserId, characterId: B.CharacterId, source: "SlayerLinks.GrantRewards", transactionId: crypto.randomUUID(),
        addStackedItems: [{ catalogId: "CURRENCY_NOTES", quantity: 1000 }], addInstancedItems: [] } });
    assert.equal(Wrong.status, 403);
    // The grant matches the entitlement, but the inventory layer rejects the
    // crown (a stateless instance must be version 0). Everything rolls back:
    // stacks, wallet and claim.
    const Bad = await Call("/inventory", { gameserver: true, method: "POST", body: {
        accountId: A.UserId, characterId: A.CharacterId, source: "SlayerLinks.GrantRewards", transactionId: crypto.randomUUID(),
        addStackedItems: [{ catalogId: "CURRENCY_NOTES", quantity: 1000 }, { catalogId: "ORB_FLAME", quantity: 20 }, { catalogId: "CURRENCY_PRESTIGE", quantity: 50 }],
        addInstancedItems: [{ catalogId: "AC_HEAD_CROWN", instanceId: "crown", updateVersion: 5 }] } });
    assert.equal(Bad.status, 400);
    assert.equal(Harness.StackedQuantity(Harness.ReadInventory(Context, A.CharacterId), "CURRENCY_NOTES"), 0);
    assert.equal(Wallet(A, "CURRENCY_PRESTIGE"), 0);
    assert.equal(Db.select().from(Schema.slayerlinkpools).all().find(R => R.userId === A.UserId).claimedAt, null);
    assert.deepEqual((await Rewards(A, 1)).json.payload.rewards, Earned);
    // Retry succeeds and delivers everything once.
    assert.equal((await Grant(A, Earned)).status, 200);
    const Inventory = Harness.ReadInventory(Context, A.CharacterId);
    assert.equal(Harness.StackedQuantity(Inventory, "CURRENCY_NOTES"), 1000);
    assert.equal(Inventory.instancedItems.filter(I => I.catalogId === "AC_HEAD_CROWN").length, 1);
    assert.equal(Wallet(A, "CURRENCY_PRESTIGE"), 50);
    assert.equal((await Grant(A, Earned)).status, 200);
    assert.equal(Harness.ReadInventory(Context, A.CharacterId).instancedItems.filter(I => I.catalogId === "AC_HEAD_CROWN").length, 1);
    // Players cannot use the grant source themselves.
    const Forged = await Call("/inventory", { account: A, method: "POST", body: {
        characterId: A.CharacterId, source: "SlayerLinks.GrantRewards", transactionId: crypto.randomUUID(),
        addStackedItems: [{ catalogId: "CURRENCY_NOTES", quantity: 1000 }] } });
    assert.equal(Forged.status, 403);
});

test("zero-progress expiry has nothing to collect and releases cleanly; a reused slot starts a fresh generation", async () => {
    const A = Player("ReuseA"), B = Player("ReuseB"), C = Player("ReuseC");
    const Old = await Link(A, B, 1, 1);
    await StorePool(A, 1);
    Clock += 7 * DAY;
    assert.deepEqual((await Rewards(A, 1)).json.payload.rewards, []);
    assert.equal((await Call("/slayerlink/links", { gameserver: true, method: "DELETE", body: { links: [{ account_id: A.UserId, slot: 1, delete_pair: false }] } })).status, 200);
    const New = await Link(A, C, 1, 1);
    assert.notEqual(New, Old);
    assert.equal((await Call(`/progression/${A.UserId}/Linked_Slayer_Slot_1`, { account: A })).json.payload.progress, 0);
    assert.deepEqual((await ListLinks(A))[0].prize_pool, []);
    // The old pool stays attached to the old link; a new pool is independent.
    assert.equal((await StorePool(A, 1, OTHER_POOL)).status, 200);
    const Pools = Db.select().from(Schema.slayerlinkpools).all().filter(R => R.userId === A.UserId);
    assert.deepEqual(Pools.map(P => P.linkId).sort(), [Old, New].sort());
    // B's side of the old link is still listed and untouched.
    assert.equal((await ListLinks(B))[0].account_id, A.UserId);
});

test("state persists across a fresh database connection", async () => {
    const A = Player("PersistA"), B = Player("PersistB");
    const Id = await Link(A, B, 2, 3);
    await StorePool(A, 2);
    SetProgress(Id, 900);
    const BetterSqlite = require("better-sqlite3");
    const Fresh = new BetterSqlite(Context.DbPath, { readonly: true });
    try {
        const Row = Fresh.prepare("SELECT * FROM slayerlinks WHERE linkId = ?").get(Id);
        assert.equal(Row.senderSlot, 2);
        assert.equal(Row.targetSlot, 3);
        assert.equal(Row.progress, 900);
        assert.deepEqual(JSON.parse(Fresh.prepare("SELECT pool FROM slayerlinkpools WHERE linkId = ?").get(Id).pool), POOL);
    } finally { Fresh.close(); }
});

test("a grant claims the link whose rewards were just read, never an unread one", async () => {
    const A = Player("BindA"), B = Player("BindB"), C = Player("BindC");
    const First = await Link(A, B, 1, 1);
    const Second = await Link(A, C, 2, 1);
    await StorePool(A, 1); await StorePool(A, 2);
    SetProgress(First, 405); SetProgress(Second, 405);
    Clock += 7 * DAY;
    const Claim = LinkId => Db.select().from(Schema.slayerlinkpools).all().find(R => R.userId === A.UserId && R.linkId === LinkId).claimedAt;
    // Identical rewards on both links: without a read nothing may be claimed.
    assert.equal((await Grant(A, POOL.slice(0, 2))).status, 409);
    assert.deepEqual((await Rewards(A, 2)).json.payload.rewards, POOL.slice(0, 2));
    assert.equal((await Grant(A, POOL.slice(0, 2))).status, 200);
    assert.ok(Claim(Second));
    assert.equal(Claim(First), null);
    // A repeat of that collection grants nothing and leaves the other link alone.
    assert.equal((await Grant(A, POOL.slice(0, 2))).status, 200);
    assert.equal(Claim(First), null);
    assert.equal(Harness.StackedQuantity(Harness.ReadInventory(Context, A.CharacterId), "CURRENCY_NOTES"), 1000);
    // The first link is still fully collectable once it is read.
    assert.deepEqual((await Rewards(A, 1)).json.payload.rewards, POOL.slice(0, 2));
    assert.equal((await Grant(A, POOL.slice(0, 2))).status, 200);
    assert.ok(Claim(First));
    assert.equal(Harness.StackedQuantity(Harness.ReadInventory(Context, A.CharacterId), "CURRENCY_NOTES"), 2000);
});

test("a link that earned chests without a stored pool is retained until a pool arrives", async () => {
    const A = Player("NoPoolA"), B = Player("NoPoolB");
    const Id = await Link(A, B, 1, 1);
    SetProgress(Id, 405);
    Clock += 7 * DAY;
    assert.equal((await Rewards(A, 1)).status, 409);
    assert.equal((await Call("/slayerlink/links", { gameserver: true, method: "DELETE", body: { links: [{ account_id: A.UserId, slot: 1, delete_pair: false }] } })).status, 409);
    assert.equal((await ListLinks(A)).length, 1);
    // The gameserver rolls a pool when the client next sees the slot; the
    // first one stored for the link is accepted even after it ended.
    assert.equal((await StorePool(A, 1)).status, 200);
    assert.equal((await StorePool(A, 1, OTHER_POOL)).status, 409);
    assert.deepEqual((await Rewards(A, 1)).json.payload.rewards, POOL.slice(0, 2));
    assert.equal((await Grant(A, POOL.slice(0, 2))).status, 200);
    assert.equal((await Call("/slayerlink/links", { gameserver: true, method: "DELETE", body: { links: [{ account_id: A.UserId, slot: 1, delete_pair: false }] } })).status, 200);
    // Zero progress and no pool: nothing was earned, so release is allowed.
    const C = Player("NoPoolC"), D = Player("NoPoolD");
    await Link(C, D, 1, 1);
    Clock += 7 * DAY;
    assert.deepEqual((await Rewards(C, 1)).json.payload.rewards, []);
    assert.equal((await Call("/slayerlink/links", { gameserver: true, method: "DELETE", body: { links: [{ account_id: C.UserId, slot: 1, delete_pair: false }] } })).status, 200);
});

test("a retried gameserver award with the same request id applies Hunt Pass and link XP once", async () => {
    const A = Player("RetryA"), B = Player("RetryB");
    const Id = await Link(A, B, 1, 1);
    const Unparty = Partied(A, B);
    const HuntPassTotal = () => Db.select().from(Schema.progression).all().find(R => R.userId === A.UserId && R.trackId === HuntPass())?.totalPoints ?? 0;
    const Award = (Amount, RequestId) => Call(`/progression/${A.UserId}/${HuntPass()}/${Amount}`, { gameserver: true, method: "POST",
        headers: { ...HuntHeaders(A, B), ...(RequestId ? { "x-undaunted-request-id": RequestId } : {}) } });
    assert.equal((await Award(100, "gs-1")).status, 200);
    assert.equal((await Award(100, "gs-1")).status, 200);
    assert.equal(HuntPassTotal(), 100);
    assert.equal(LinkRow(Id).progress, 100);
    // Same id with different content is refused, not guessed at.
    assert.equal((await Award(50, "gs-1")).status, 409);
    // A distinct award of the same size still counts.
    assert.equal((await Award(100, "gs-2")).status, 200);
    assert.equal(HuntPassTotal(), 200);
    assert.equal(LinkRow(Id).progress, 200);
    // The bulk form is protected the same way.
    const Bulk = () => Call(`/progression/${A.UserId}`, { gameserver: true, method: "POST",
        headers: { ...HuntHeaders(A, B), "x-undaunted-request-id": "gs-3" },
        body: { progress_tracks: [{ progression_id: HuntPass(), progress: 5 }], objectives: [] } });
    await Bulk(); await Bulk();
    assert.equal(HuntPassTotal(), 205);
    assert.equal(LinkRow(Id).progress, 205);
    // A player cannot supply a request id to dodge anything: the header is
    // only read from gameservers, and players cannot award at all.
    assert.equal((await Call(`/progression/${A.UserId}/${HuntPass()}/100`, { account: A, method: "POST", headers: { "x-undaunted-request-id": "gs-9" } })).status, 403);
    Unparty();
});


test("the inviter keeps seeing an answered invite with its native status until it expires", async () => {
    const A = Player("InvA"), B = Player("InvB"), C = Player("InvC");
    const Invites = async P => (await Call("/slayerlink/invites", { account: P })).json.payload.invites;
    await Link(A, B, 2, 1);
    const Sent = await Invites(A);
    assert.equal(Sent.length, 1);
    assert.deepEqual([Sent[0].account_id, Sent[0].slot, Sent[0].direction, Sent[0].status], [B.UserId, 2, "Sent", "Accepted"]);
    assert.deepEqual(await Invites(B), [], "the accepting side is not shown the answered invite");
    await Befriend(A, C);
    await Call("/slayerlink/invite", { account: A, method: "PUT", body: { account_id: C.UserId, slot: 3 } });
    assert.deepEqual((await Invites(C)).map(I => [I.direction, I.status]), [["Received", "Pending"]]);
    await Call("/slayerlink/invite", { account: C, method: "POST", body: { account_id: A.UserId, action: "reject" } });
    assert.deepEqual((await Invites(A)).map(I => [I.account_id, I.status]).sort(), [[B.UserId, "Accepted"], [C.UserId, "Declined"]].sort());
    assert.deepEqual(await Invites(C), []);
    Clock += 24 * 3600_000;
    assert.deepEqual(await Invites(A), []);
});

test("the pool format the 1.4.4 gameserver really sends is accepted and read correctly", async () => {
    const A = Player("NativeA"), B = Player("NativeB");
    const Id = await Link(A, B, 1, 1);
    // Captured from Ramsgate's PUT /slayerlink/links/rewards: twelve prizes
    // (ClassesToDraw 5+4+2+1), one per chest level, the rest at -1.
    const Native = [
        ["GEM_ALPHA", 25, -1], ["GEM_HEROIC", 10, 1], ["CURRENCY_NOTES", 2000, 3], ["CURRENCY_NOTES", 1000, -1],
        ["CURRENCY_PRESTIGE", 10, -1], ["GEM_HEROIC", 100, -1], ["ORB_FLAME", 20, 2], ["TOKEN_BOUNTY_DRAFT", 3, -1],
        ["QI_DAMAGE_BLOCK_POTION", 10, -1], ["QI_DAMAGE_BLOCK_POTION", 15, -1], ["TOKEN_DAILY_PATROL_BONUS_PURCHASED", 3, 4], ["CURRENCY_NOTES", 3000, -1]
    ].map(([catalog_id, quantity, received_for_level]) => ({ catalog_id, quantity, received_for_level }));
    const Put = await Call("/slayerlink/links/rewards", { gameserver: true, method: "PUT", body: { links: [{ account_id: A.UserId, slot: 1, prize_pool: Native }] } });
    assert.equal(Put.status, 200, JSON.stringify(Put.json));
    assert.deepEqual((await ListLinks(A))[0].prize_pool, Native);
    SetProgress(Id, 405);
    Clock += 7 * DAY;
    assert.deepEqual((await Rewards(A, 1)).json.payload.rewards.map(R => [R.catalog_id, R.quantity, R.received_for_level]),
        [["GEM_HEROIC", 10, 1], ["ORB_FLAME", 20, 2]]);
});

test("cancel and relink never resurrects old accepted notices, including same-millisecond replacements", async () => {
    const A = Player("CycleA"), B = Player("CycleB"), C = Player("CycleC");
    const Invites = async P => (await Call("/slayerlink/invites", { account: P })).json.payload.invites;
    let Old;
    for(let I = 0; I < 3; I++) {
        Old = await Link(A, B);
        assert.equal((await Invites(A)).length, 1);
        assert.equal((await Call("/slayerlink/link", { account: B, method: "DELETE", body: { slot: 1 } })).status, 200);
        assert.deepEqual(await ListLinks(A), []);
        assert.deepEqual(await ListLinks(B), []);
        assert.deepEqual((await Invites(A)).map(N => N.status), ["Canceled"]);
        assert.equal((await Call("/slayerlink/invite", { account: B, method: "POST", body: { link_id: Old, action: "accept", slot: 1 } })).status, 409);
    }
    const Current = await Link(A, B);
    assert.deepEqual((await Invites(A)).map(N => [N.link_id, N.status]), [[Current, "Accepted"]]);
    assert.deepEqual(await Invites(B), []);
    assert.equal((await ListLinks(A)).length, 1);
    assert.equal((await ListLinks(B)).length, 1);
    await Call("/slayerlink/link", { account: A, method: "DELETE", body: { slot: 1 } });
    const Replacement = await Link(A, C);
    assert.deepEqual((await Invites(A)).map(N => [N.link_id, N.status]), [[Replacement, "Accepted"]]);
});

test("pending invitations reserve outgoing slots and cannot be silently moved", async () => {
    const A = Player("ReserveA"), B = Player("ReserveB"), C = Player("ReserveC");
    await Befriend(A, B); await Befriend(A, C); await Befriend(B, C);
    const Send = (Target, Slot) => Call("/slayerlink/invite", { account: A, method: "PUT", body: { account_id: Target.UserId, slot: Slot } });
    const First = await Send(B, 1);
    assert.equal(First.status, 200);
    assert.deepEqual((await Send(B, 1)).json, First.json);
    assert.equal((await Send(B, 2)).status, 409);
    assert.equal((await Send(C, 1)).status, 409);
    assert.equal((await Call("/slayerlink/invite", { account: C, method: "PUT", body: { account_id: A.UserId, slot: 1 } })).status, 200);
    assert.equal((await Call("/slayerlink/invite", { account: A, method: "POST", body: { account_id: C.UserId, action: "accept", slot: 1 } })).status, 409);
    assert.equal((await Call("/slayerlink/invite", { account: A, method: "POST", body: { account_id: C.UserId, action: "accept", slot: 2 } })).status, 200);
    Clock += DAY;
    assert.equal((await Send(B, 1)).status, 200, "expired reservations free their slots");
});

test("legacy canceled accepted rows are not exposed as accepted or successfully accepted again", async () => {
    const A = Player("LegacyNoticeA"), B = Player("LegacyNoticeB");
    const Id = await Link(A, B);
    const { eq } = require("drizzle-orm");
    Db.update(Schema.slayerlinks).set({ canceledAt: Clock }).where(eq(Schema.slayerlinks.linkId, Id)).run();
    const Notices = (await Call("/slayerlink/invites", { account: A })).json.payload.invites;
    assert.deepEqual(Notices.map(N => N.status), ["Canceled"]);
    assert.equal((await Call("/slayerlink/invite", { account: B, method: "POST", body: { account_id: A.UserId, action: "accept", slot: 1 } })).status, 409);
});

test("processed delete and pool retries cannot mutate a replacement link", async () => {
    const A = Player("ReplayA"), B = Player("ReplayB");
    await Link(A, B);
    const OldPool = await StorePool(A, 1, POOL, { headers: { "x-undaunted-request-id": "old-pool" } });
    const Delete = () => Call("/slayerlink/links", { gameserver: true, method: "DELETE",
        headers: { "x-undaunted-request-id": "old-delete" }, body: { links: [{ account_id: A.UserId, slot: 1, delete_pair: true }] } });
    const FirstDelete = await Delete();
    assert.equal(FirstDelete.status, 200);
    const Replacement = await Link(A, B);
    assert.deepEqual(await Delete(), FirstDelete);
    assert.equal(LinkRow(Replacement).canceledAt, null);
    assert.deepEqual(await StorePool(A, 1, POOL, { headers: { "x-undaunted-request-id": "old-pool" } }), OldPool);
    assert.deepEqual((await ListLinks(A))[0].prize_pool, []);
    assert.equal((await StorePool(A, 1, OTHER_POOL, { headers: { "x-undaunted-request-id": "old-pool" } })).status, 409);
    // A failed multi-delete rolls back both the first deletion and receipt.
    const BadDelete = await Call("/slayerlink/links", { gameserver: true, method: "DELETE",
        headers: { "x-undaunted-request-id": "rolled-back-delete" }, body: { links: [{ account_id: A.UserId, slot: 1 }, { account_id: A.UserId, slot: 4 }] } });
    assert.equal(BadDelete.status, 400);
    assert.equal(LinkRow(Replacement).canceledAt, null);
    assert.equal(Db.select().from(Schema.slayerlinkrequests).all().some(R => R.requestId === "rolled-back-delete"), false);
});

test("generation-aware deletes and pool writes refuse first-delivered stale requests", async () => {
    const A = Player("GenerationA"), B = Player("GenerationB");
    const Old = await Link(A, B);
    await Call("/slayerlink/link", { account: A, method: "DELETE", body: { slot: 1, link_id: Old } });
    const Current = await Link(A, B);
    assert.equal((await Call("/slayerlink/link", { account: A, method: "DELETE", body: { slot: 1, link_id: Old } })).status, 409);
    assert.equal((await Call("/slayerlink/links/rewards", { gameserver: true, method: "PUT", body: [{ account_id: A.UserId, slot: 1, link_id: Old, prize_pool: POOL }] })).status, 409);
    assert.equal(LinkRow(Current).canceledAt, null);
    assert.deepEqual((await ListLinks(A))[0].prize_pool, []);
});

test("PUT invite actions cancel rather than create, and old retries cannot cancel a new invite", async () => {
    const A = Player("PutCancelA"), B = Player("PutCancelB");
    await Befriend(A, B);
    const Send = () => Call("/slayerlink/invite", { account: A, method: "PUT", body: { account_id: B.UserId, slot: 1 } });
    const Old = await Send();
    const Cancel = () => Call("/slayerlink/invite", { account: A, method: "PUT", headers: { "x-undaunted-request-id": "cancel-request" }, body: { account_id: B.UserId, slot: 1, action: "cancel" } });
    const Canceled = await Cancel();
    assert.equal(Canceled.status, 200);
    const Current = await Send();
    assert.notEqual(Current.json.payload.link_id, Old.json.payload.link_id);
    assert.deepEqual(await Cancel(), Canceled);
    const Pending = (await Call("/slayerlink/invites", { account: B })).json.payload.invites;
    assert.deepEqual(Pending.map(I => [I.link_id, I.status]), [[Current.json.payload.link_id, "Pending"]]);
    assert.equal((await Call("/slayerlink/invite", { account: A, method: "PUT", body: { account_id: B.UserId, slot: 2, action: "typo" } })).status, 400);
});
