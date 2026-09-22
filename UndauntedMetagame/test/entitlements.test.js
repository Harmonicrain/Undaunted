"use strict";

// Entitlement grants through the store, and the shared inventory path.
//
// Covers the three gaps closed here:
//   1. an offer under a non-webstore tag was reported as unknown (404)
//   2. an entitlement-granting offer was rejected (409) and never granted
//   3. redeem wrote inventory directly, bypassing the replay ledger

const { test, before, after } = require("node:test");
const assert = require("node:assert");

const Harness = require("./harness.js");

let Context;
let FreeStore;
let Entitlements;
let Schema;

before(() => {
    const Keys = require("node:crypto").generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.AUTH_SIGNING_PRIVKEY_B64 = Buffer.from(Keys.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
    process.env.AUTH_SIGNING_PUBKEY_B64 = Buffer.from(Keys.publicKey.export({ type: "spki", format: "pem" })).toString("base64");
    Context = Harness.CreateDisposableDatabase();
    FreeStore = require("../dist/controllers/freeStore.js");
    Entitlements = require("../dist/controllers/entitlements.js");
    Schema = Context.Schema;
});

after(() => {
    Context.Cleanup();
});

function Ledger(characterId) {
    const { eq } = require("drizzle-orm");
    return Context.Db.select().from(Schema.inventorytransactions)
        .where(eq(Schema.inventorytransactions.characterId, characterId)).all();
}

// ------------------------------------------------------------- offer lookup

test("an offer outside the webstore tag is found rather than reported unknown", async () => {
    const Account = Harness.SeedAccount(Context);

    // season09b_premium lives under the season09b_pass tag. Looking only at
    // catalog.webstore made this throw 404 before any other check ran.
    const Result = FreeStore.CreateFreePurchase(Account.UserId, "platinum", "season09b_premium");

    assert.ok(Result.purchaseToken, "a purchase token should be issued");
    assert.match(Result.purchaseToken, /^[a-f0-9]{64}$/);
});

test("an unknown sku is still rejected", async () => {
    const Account = Harness.SeedAccount(Context);

    assert.throws(
        () => FreeStore.CreateFreePurchase(Account.UserId, "platinum", "not_a_real_sku"),
        (error) => error.status === 404);
});

test("a single-offer lookup finds a sku outside the webstore tag", async () => {
    const Account = Harness.SeedAccount(Context);

    // The purchase dialog fetches the offer detail by id. Searching only the
    // storefront list returned 404 here, and the dialog sat spinning.
    const Offer = FreeStore.GetOfferById(Account.UserId, "season09b_premium");

    assert.strictEqual(Offer.id, "season09b_premium");
    assert.strictEqual(Offer.remaining, 1, "not yet owned");
});

test("an entitlement offer reads as owned once granted", async () => {
    const Account = Harness.SeedAccount(Context);

    const { purchaseToken } = FreeStore.CreateFreePurchase(Account.UserId, "platinum", "season09b_premium");
    FreeStore.RedeemFreePurchase(Account.UserId, "platinum", purchaseToken);

    // An entitlement-only offer has no items, so ownership cannot be decided
    // from inventory alone.
    assert.strictEqual(FreeStore.GetOfferById(Account.UserId, "season09b_premium").remaining, 0);
});

// ------------------------------------------------------------- entitlements

test("redeeming the pass grants the entitlement", async () => {
    const Account = Harness.SeedAccount(Context);

    assert.strictEqual(await Entitlements.HasEntitlement(Account.UserId, "season09b_premium"), false,
        "should start without the entitlement");

    const { purchaseToken } = FreeStore.CreateFreePurchase(Account.UserId, "platinum", "season09b_premium");
    FreeStore.RedeemFreePurchase(Account.UserId, "platinum", purchaseToken);

    assert.strictEqual(await Entitlements.HasEntitlement(Account.UserId, "season09b_premium"), true);
});

test("entitlements are returned in the shape the client reads", async () => {
    const Account = Harness.SeedAccount(Context);

    const { purchaseToken } = FreeStore.CreateFreePurchase(Account.UserId, "platinum", "season09b_premium");
    FreeStore.RedeemFreePurchase(Account.UserId, "platinum", purchaseToken);

    const Held = await Entitlements.GetEntitlementsForUser(Account.UserId);

    assert.strictEqual(Held.length, 1);
    assert.deepStrictEqual(Object.keys(Held[0]).sort(), ["activatedDate", "duration", "name"]);
    assert.strictEqual(Held[0].name, "season09b_premium");
    assert.ok(!Number.isNaN(Date.parse(Held[0].activatedDate)), "activatedDate must be a date");
});

test("GET /entitlementsv2 matches the 1.4.4 QueryEntitlements response contract", async () => {
    const express = require("express");
    const { once } = require("node:events");
    const { SignMetagameJWTForUid } = require("../dist/controllers/auth.js");
    const Account = Harness.SeedAccount(Context);
    const OtherAccount = Harness.SeedAccount(Context);
    const { purchaseToken } = FreeStore.CreateFreePurchase(Account.UserId, "platinum", "season09b_premium");
    FreeStore.RedeemFreePurchase(Account.UserId, "platinum", purchaseToken);
    const app = express();
    app.use(require("../dist/routes/system.js").systemRouter);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
        for (const [UserId, ExpectedNames] of [[Account.UserId, ["season09b_premium"]], [OtherAccount.UserId, []]]) {
            const response = await fetch(`http://127.0.0.1:${server.address().port}/entitlementsv2`, {
                headers: { authorization: `Bearer ${SignMetagameJWTForUid(UserId)}` }
            });
            assert.strictEqual(response.status, 200);
            const body = await response.json();
            // Native QueryEntitlements deserializes the root object directly.
            // Its array member is "entitlements", and its entries read "name".
            assert.deepStrictEqual(Object.keys(body), ["entitlements"]);
            assert.deepStrictEqual(body.entitlements.map(entry => entry.name), ExpectedNames);
            for (const entry of body.entitlements) {
                assert.deepStrictEqual(Object.keys(entry).sort(), ["activatedDate", "duration", "name"]);
                assert.strictEqual(entry.duration, 0);
                assert.ok(!Number.isNaN(Date.parse(entry.activatedDate)));
            }
        }
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});

test("a second purchase of the same entitlement does not duplicate it", async () => {
    const Account = Harness.SeedAccount(Context);

    for (let i = 0; i < 2; i++) {
        const { purchaseToken } = FreeStore.CreateFreePurchase(Account.UserId, "platinum", "season09b_premium");
        FreeStore.RedeemFreePurchase(Account.UserId, "platinum", purchaseToken);
    }

    const Held = await Entitlements.GetEntitlementsForUser(Account.UserId);
    assert.strictEqual(Held.length, 1, "the entitlement must be held once, not twice");
});

test("redeeming the same token twice is idempotent", async () => {
    const Account = Harness.SeedAccount(Context);

    const { purchaseToken } = FreeStore.CreateFreePurchase(Account.UserId, "platinum", "season09b_premium");
    FreeStore.RedeemFreePurchase(Account.UserId, "platinum", purchaseToken);
    FreeStore.RedeemFreePurchase(Account.UserId, "platinum", purchaseToken);

    assert.strictEqual((await Entitlements.GetEntitlementsForUser(Account.UserId)).length, 1);
});

// -------------------------------------------------- shared inventory path

test("a cosmetic purchase is recorded in the inventory replay ledger", async () => {
    const Account = Harness.SeedAccount(Context);

    assert.strictEqual(Ledger(Account.CharacterId).length, 0);

    const { purchaseToken } = FreeStore.CreateFreePurchase(Account.UserId, "platinum", "bundle_armour_iron");
    FreeStore.RedeemFreePurchase(Account.UserId, "platinum", purchaseToken);

    // Writing inventory directly would leave this empty. A ledger row proves
    // the grant went through the shared inventory core.
    assert.strictEqual(Ledger(Account.CharacterId).length, 1,
        "the store grant should appear in the shared inventory ledger");

    const Held = Harness.ReadInventory(Context, Account.CharacterId);
    assert.ok(Held.stackedItems.length > 0, "items should have been granted");
});

test("an already-owned cosmetic is not granted a second copy", async () => {
    const Account = Harness.SeedAccount(Context);

    for (let i = 0; i < 2; i++) {
        const { purchaseToken } = FreeStore.CreateFreePurchase(Account.UserId, "platinum", "bundle_armour_iron");
        FreeStore.RedeemFreePurchase(Account.UserId, "platinum", purchaseToken);
    }

    const Held = Harness.ReadInventory(Context, Account.CharacterId);

    for (const stack of Held.stackedItems) {
        assert.strictEqual(stack.quantity, 1,
            `${stack.catalogId} should be held once, cosmetics are unlocks`);
    }
});

// ---------------------------------------------------------------- catalogue

test("every storefront offer can be purchased and redeemed", async () => {
    const Account = Harness.SeedAccount(Context);
    const Catalog = require("../src/vendor/store_catalog.json");

    // Offers are hand-authored JSON. A typo in a catalogue id, a quantity
    // other than 1, or a non-armour item would only surface when a player
    // clicked Purchase - offerFor rejects it at redeem time. Catch it here.
    for (const Offer of Catalog.webstore) {
        const { purchaseToken } = FreeStore.CreateFreePurchase(Account.UserId, "platinum", Offer.id);
        FreeStore.RedeemFreePurchase(Account.UserId, "platinum", purchaseToken);
    }

    // Lanterns, fabrics and standards are granted as instanced items, the rest
    // as stacked, so ownership has to be read from both.
    const Inventory = Harness.ReadInventory(Context, Account.CharacterId);
    const Held = new Set([
        ...Inventory.stackedItems.map((Stack) => Stack.catalogId),
        ...Inventory.instancedItems.map((Instance) => Instance.catalogId)
    ]);

    for (const Offer of Catalog.webstore) {
        for (const Item of Offer.items ?? []) {
            assert.ok(Held.has(Item.catalogId), `${Offer.id} should have granted ${Item.catalogId}`);
        }
    }

    // Every cosmetic offer now reads as owned, so none can be bought twice.
    // Consumable bundles (bounty tokens) stay on sale.
    for (const Offer of FreeStore.GetFreeStoreOffers(Account.UserId)) {
        const Repeatable = Offer.items.length > 0 &&
            Offer.items.every((Item) => Item.catalogId === "TOKEN_BOUNTY_DRAFT_PREMIUM");
        assert.strictEqual(Offer.remaining, Repeatable ? 1 : 0, `${Offer.id} ownership`);
    }
});

test("bounty tokens can be bought repeatedly and each purchase adds the full bundle", () => {
    const Account = Harness.SeedAccount(Context);
    const Sku = "bundle_currency_bounty_small";

    for (let Purchase = 0; Purchase < 2; Purchase++) {
        const { purchaseToken } = FreeStore.CreateFreePurchase(Account.UserId, "platinum", Sku);
        FreeStore.RedeemFreePurchase(Account.UserId, "platinum", purchaseToken);
        // A retried redeem of the same token must not add a second bundle.
        FreeStore.RedeemFreePurchase(Account.UserId, "platinum", purchaseToken);
    }

    const Inventory = Harness.ReadInventory(Context, Account.CharacterId);
    assert.strictEqual(Harness.StackedQuantity(Inventory, "TOKEN_BOUNTY_DRAFT_PREMIUM"), 40);
    assert.strictEqual(FreeStore.GetOfferById(Account.UserId, Sku).remaining, 1);
});

test("sheen and hair tint offers grant the entitlements the client's own tables name", () => {
    const Account = Harness.SeedAccount(Context);

    // SKU -> entitlement pairs from /Game/Gameplay/dye_sheen_table and
    // /Game/UI/Appearance/appearance_hair_colour_premium_table.
    const Expected = {
        single_dye_sheen_glossy: ["ent_dye_sheen_glossy"],
        single_dye_sheen_metallic: ["ent_dye_sheen_metallic"],
        single_dye_hairtint_01: ["ent_cchd_hp07a_01"],
        bundle_hairtint_springtime: ["ent_cchd_hp09a_assassins_01", "ent_cchd_hp09a_assassins_02",
            "ent_cchd_hp09a_assassins_03", "ent_cchd_hp09a_assassins_04", "ent_cchd_hp09a_assassins_05"]
    };

    for (const [Sku, Names] of Object.entries(Expected)) {
        const { purchaseToken } = FreeStore.CreateFreePurchase(Account.UserId, "platinum", Sku);
        FreeStore.RedeemFreePurchase(Account.UserId, "platinum", purchaseToken);

        const Held = Context.Db.select().from(Context.Schema.entitlements).all()
            .filter((Row) => Row.userId === Account.UserId).map((Row) => Row.entitlement);
        for (const Name of Names) assert.ok(Held.includes(Name), `${Sku} should grant ${Name}`);
        assert.strictEqual(FreeStore.GetOfferById(Account.UserId, Sku).remaining, 0, `${Sku} should read as owned`);
    }
});

test("store grants land stacked or instanced exactly as the catalogue flag says", () => {
    const Account = Harness.SeedAccount(Context);
    const Catalog = require("../src/vendor/store_catalog.json");
    const Kinds = require("../src/vendor/store_item_kinds.json");

    for (const Offer of Catalog.webstore) {
        const { purchaseToken } = FreeStore.CreateFreePurchase(Account.UserId, "platinum", Offer.id);
        FreeStore.RedeemFreePurchase(Account.UserId, "platinum", purchaseToken);
    }

    // A non-stackable item written as a stack (or the reverse) is held in the
    // database but never shows in game. Weapon skins are the common case: most
    // are instanced, which a prefix rule had granted as stacks.
    const Inventory = Harness.ReadInventory(Context, Account.CharacterId);
    const Stacked = new Set(Inventory.stackedItems.map((Stack) => Stack.catalogId));
    const Instanced = new Set(Inventory.instancedItems.map((Instance) => Instance.catalogId));

    for (const Offer of Catalog.webstore) {
        for (const Item of Offer.items) {
            const Expected = Kinds[Item.catalogId];
            assert.ok(Expected === "stacked" || Expected === "instanced", `${Item.catalogId} has no recorded kind`);
            assert.ok((Expected === "stacked" ? Stacked : Instanced).has(Item.catalogId), `${Item.catalogId} should be ${Expected}`);
            assert.ok(!(Expected === "stacked" ? Instanced : Stacked).has(Item.catalogId), `${Item.catalogId} granted both ways`);
        }
    }
});

test("storefront offer ids are unique", () => {
    const Catalog = require("../src/vendor/store_catalog.json");
    const Ids = Object.entries(Catalog)
        .filter(([Key, Value]) => !Key.startsWith("_") && Array.isArray(Value))
        .flatMap(([, Value]) => Value.map((Offer) => Offer.id));

    assert.strictEqual(new Set(Ids).size, Ids.length, "duplicate offer ids break single-offer lookup");
});

test("every storefront offer id is a StoreItemsTable row with 2:1 art, so its tile is neither blank nor stretched", () => {
    const Catalog = require("../src/vendor/store_catalog.json");
    const ArtRows = new Set(require("../src/vendor/store_art_skus.json"));

    // The 1.4.4 client picks tile art from /Game/UI/Store/StoreItemsTable, keyed
    // by SKU id. An id that is not a row with an image renders the generic
    // samurai fallback - which is how a catalogue of item-id offers ended up
    // looking broken. The id is the only thing that decides this. The tile
    // frame is a fixed 2:1, so store_art_skus.json lists only rows whose
    // texture is 2:1; the square Hunt Pass icons render visibly stretched.
    const Missing = Catalog.webstore.filter((Offer) => !ArtRows.has(Offer.id)).map((Offer) => Offer.id);

    assert.deepStrictEqual(Missing, [], `offers without store art: ${Missing.join(", ")}`);
});

test("no store tab before a populated tab is left empty", () => {
    const Catalog = require("../src/vendor/store_catalog.json");
    const Tags = new Set(Catalog.webstore.flatMap((Offer) => Offer.tags));

    // The tab bar indexes the full tab list including hidden (empty) tabs, so an
    // empty tab ahead of a populated one shifts every later tab: EMOTES opened
    // the weapons page. Leading tabs and sub-tabs must each hold something.
    for (const Required of ["feature", "your_offers", "supplies_boost", "skin_weapon_ac", "skin_weapon_eb",
        "skin_weapon_dp", "skin_weapon_ih", "skin_weapon_ga", "skin_weapon_ms", "skin_weapon_cb",
        "skin_armour", "skin_lantern", "social_arrival", "social_emote", "dye_armour",
        "personality_stylekit", "personality_character", "personality_flaresigil", "personality_fabric"]) {
        assert.ok(Tags.has(Required), `${Required} must not be empty`);
    }
});
