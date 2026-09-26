import { createHash, randomBytes } from "node:crypto";
import { and, eq, gte, ne } from "drizzle-orm";
import { GetDb } from "../db";
import { characters, entitlements, inventory, storepurchases } from "../db/schema";
import { ApplyInventoryTransaction } from "./inventory";
import { StoreCatalog as catalog, StoreItemKinds as itemKinds } from "./storeCatalog";
import { CanonicaliseCurrency, CreditWallet, DebitWallet, InsufficientFundsError, IsCurrency, WalletBalance } from "./wallet";
import { IsEntitlementActive } from "./entitlements";
import { IsStoreTagOpen, StoreTagWindow } from "./seasonalEvents";

export class StoreError extends Error {
    constructor(public status: number, message: string) { super(message); }
}

const catalogTags = Object.entries(catalog as Record<string, any>)
    .filter(([key]) => !key.startsWith("_"));

// Every offer across every tag. Scoping this to catalog.webstore meant a SKU
// under any other tag (the Hunt Pass pass, rank skips) was reported as unknown.
const offers: any[] = catalogTags.flatMap(([, value]) => Array.isArray(value) ? value : []);

const webstoreOffers: any[] = (catalog as Record<string, any>).webstore ?? [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const offerHash = (offer: typeof offers[number]) => hash(JSON.stringify(offer));

function player(userId: unknown): asserts userId is string {
    if (typeof userId !== "string" || !userId) throw new StoreError(401, "Player authentication required");
}

function character(userId: string) {
    player(userId);
    // This protocol supplies no character ID. Refuse ambiguity instead of
    // delivering a purchase to an arbitrary character.
    const rows = GetDb().select().from(characters).where(eq(characters.userId, userId)).all();
    if (rows.length !== 1) throw new StoreError(409, "Store requires exactly one character");
    return rows[0];
}

// Consumables that may be bought any number of times and in any quantity.
// TOKEN_BOUNTY_DRAFT_PREMIUM is the premium_bounty_token_id served by
// /bounty/game-data: the purchased kind, which persists into the next season.
// A generated catalogue lists its own under _repeatableItems (1.12.0 adds tonics).
const REPEATABLE_ITEMS = new Set<string>(Array.isArray(catalog._repeatableItems)
    ? catalog._repeatableItems : ["TOKEN_BOUNTY_DRAFT_PREMIUM"]);

// How each item is granted, stacked or instanced. A per-type prefix rule got
// this wrong for individual items: most weapon skins and a few arrivals are
// instanced, a few fabrics and lanterns are stacked. The live ArchonCatalog
// stackable flag decides it, and the real season09b config agrees with that
// flag for every item it grants. store_item_kinds.json records the flag for
// every item the catalogue sells - and only those, so it is also the list of
// what the store may hand out at all. Anything else (currencies, boosts,
// weapons proper) is refused even if an offer lists it. For the 1.4.4
// catalogue this is the same set the old cosmetic prefix rule allowed.
const ITEM_KINDS = itemKinds as Record<string, string>;

export function GrantKind(catalogId: string): "stacked" | "instanced" | undefined {
    const kind = ITEM_KINDS[catalogId];
    return kind === "stacked" || kind === "instanced" ? kind : undefined;
}

// What an offer costs, paid from the wallet: platinumPrice in Platinum (Hunt
// Pass ranks and the fountain pay Platinum in), or, for an offer naming a
// priceCurrency, price in that currency - the Reward Cache sells for the
// season's coin (CURRENCY_S19_COIN), which challenges pay in.
const PLATINUM_WALLET = "CURRENCY_PLATINUM";
export function OfferPrice(offer: any): { currency: string; amount: number } {
    return typeof offer?.priceCurrency === "string"
        ? { currency: CanonicaliseCurrency(offer.priceCurrency), amount: offer.price }
        : { currency: PLATINUM_WALLET, amount: offer?.platinumPrice };
}

// The client names the purchase currency in the token and notification paths:
// 1.4.4 sends "platinum", 1.12.0 the price's currencyId (id_currency_platinum,
// id_currency_s19_coin, ...). A purchase must be paid in the offer's currency.
function PathCurrency(currency: unknown) {
    const name = String(currency).toLowerCase();
    return CanonicaliseCurrency(name === "platinum" ? PLATINUM_WALLET : name.replace(/^id_/, "").toUpperCase());
}
const PaysIn = (offer: any, currency: unknown) => PathCurrency(currency) === OfferPrice(offer).currency;

// A repeatable offer sells consumables only. It is never "owned", and each
// purchase grants its full quantity again.
function IsRepeatable(offer: any) {
    const items: { catalogId: string }[] = offer.items ?? [];
    return items.length > 0 && items.every(item => REPEATABLE_ITEMS.has(item.catalogId));
}

// A limited offer is bought once per window: "limit": "daily" per UTC day
// ("daily": true, the fountain's form, means the same) or "weekly" from
// Thursday 00:00 UTC, the day the live weekly challenges rolled over.
type Limit = "daily" | "weekly";
function LimitOf(offer: any): Limit | undefined {
    if (offer?.limit === "daily" || offer?.daily === true) return "daily";
    if (offer?.limit === "weekly") return "weekly";
    return undefined;
}

export function DailyResetAt(now: number) {
    const day = new Date(now);
    return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
}

export function LimitWindowStart(limit: Limit, now: number) {
    const day = DailyResetAt(now);
    if (limit === "daily") return day;
    const sinceThursday = (new Date(day).getUTCDay() - 4 + 7) % 7;
    return day - sinceThursday * 24 * 60 * 60 * 1000;
}

function BoughtThisWindow(db: any, userId: string, offer: any, now: number, exceptTokenHash?: string) {
    const limit = LimitOf(offer);
    if (!limit) return false;
    const conditions = [eq(storepurchases.userId, userId), eq(storepurchases.skuId, offer.id),
        gte(storepurchases.redeemedAt, LimitWindowStart(limit, now))];
    if (exceptTokenHash) conditions.push(ne(storepurchases.tokenHash, exceptTokenHash));
    return db.select().from(storepurchases).where(and(...conditions)).get() !== undefined;
}

// A bundle hands out cores, tokens and currencies: the Bazaar fountain's daily
// gift (tag fountain_daily_free_bundle; the game opens the Fountain Core itself
// at the Core Breaker) and the Reward Cache's Rams, Combat Merits, Patrol Keys
// and Aethersparks. Unlike the storefront's cosmetics it is validated and
// granted on its own terms, the way Hunt Pass rank rewards are, and can be
// bought again - once per window when it is limited.
const IsBundle = (offer: any) => offer?.bundle === true || LimitOf(offer) !== undefined;

function BundleOffer(offer: any) {
    const items: { catalogId: string; quantity: number }[] = offer.items ?? [];
    if (!items.length || (offer.entitlements ?? []).length) throw new StoreError(409, "Bundles grant cores, tokens and currencies only");
    if (items.some(item => typeof item.catalogId !== "string" || !/^(CONTAINER|CURRENCY|TOKEN)_[A-Z0-9_]+$/.test(item.catalogId) ||
        !Number.isSafeInteger(item.quantity) || item.quantity <= 0)) {
        throw new StoreError(409, "Offer is not a supported bundle");
    }
    return offer;
}

// Priced offers must not charge for nothing: a cosmetic the character already
// holds is not granted again, and a timed entitlement does not change a
// permanent one.
function GrantsNothing(offer: any, held: Set<string>, active: { entitlement: string; duration: number }[]) {
    if (IsBundle(offer) || IsRepeatable(offer)) return false;
    const items: { catalogId: string }[] = offer.items ?? [];
    const grants: { name: string; duration?: number }[] = offer.entitlements ?? [];
    return items.every(item => held.has(item.catalogId)) &&
        grants.every(grant => active.some(row => row.entitlement === grant.name && row.duration === 0));
}

// An event's store (Honest Ozz's) is open only while its event runs: see
// controllers/seasonalEvents. Its offers are neither listed nor sold outside it.
const IsOfferOpen = (offer: any) => (offer?.tags ?? []).every((tag: string) => IsStoreTagOpen(tag));

// An event's offer is available for its event's window, and says so.
function WithEventWindow(offer: any) {
    const window = (offer?.tags ?? []).map((tag: string) => StoreTagWindow(tag)).find((found: any) => found != undefined);
    return window == undefined ? offer : { ...offer, ...window };
}

function offerFor(skuId: string, currency: string) {
    const offer = offers.find(item => item.id === skuId);
    if (!offer) throw new StoreError(404, "Unknown store offer");
    if (!IsOfferOpen(offer)) throw new StoreError(409, "This event has ended");
    const price = OfferPrice(offer);
    if (!Number.isSafeInteger(price.amount) || price.amount < 0 ||
        (price.currency !== PLATINUM_WALLET && (price.amount === 0 || !IsCurrency(price.currency)))) {
        throw new StoreError(409, "Offer has an invalid price");
    }
    if (!PaysIn(offer, currency)) throw new StoreError(400, "Unsupported store currency");
    if (IsBundle(offer)) return BundleOffer(offer);
    // Supported grants are permanent cosmetics, repeatable consumables and
    // entitlements (permanent, or timed in hours). Most offers are free; a
    // priced one charges its price from the wallet.
    const items: { catalogId: string; quantity: number }[] = offer.items ?? [];
    const grants: { name: string; duration?: number }[] = offer.entitlements ?? [];

    if (!items.length && !grants.length) throw new StoreError(409, "Offer grants nothing");
    const repeatable = IsRepeatable(offer);
    if (repeatable && grants.length) throw new StoreError(409, "Repeatable offers cannot grant entitlements");
    if (items.some(item => GrantKind(item.catalogId) === undefined ||
        REPEATABLE_ITEMS.has(item.catalogId) !== repeatable ||
        (repeatable ? GrantKind(item.catalogId) !== "stacked" || !Number.isSafeInteger(item.quantity) || item.quantity <= 0
            : item.quantity !== 1))) {
        throw new StoreError(409, "Offer is not a supported store item");
    }
    if (grants.some(grant => typeof grant.name !== "string" || !grant.name ||
        !Number.isSafeInteger(grant.duration ?? 0) || (grant.duration ?? 0) < 0)) {
        throw new StoreError(409, "Offer has an unusable entitlement");
    }
    return offer;
}

function stacks(raw: string): { catalogId: string; quantity: number }[] {
    const value = JSON.parse(raw);
    if (!Array.isArray(value) || value.some(item => !item || typeof item.catalogId !== "string" ||
        !Number.isSafeInteger(item.quantity) || item.quantity < 0)) {
        throw new StoreError(500, "Invalid stored inventory");
    }
    return value;
}

function instances(raw: string): { catalogId: string }[] {
    const value = JSON.parse(raw);
    if (!Array.isArray(value) || value.some(item => !item || typeof item.catalogId !== "string")) {
        throw new StoreError(500, "Invalid stored inventory");
    }
    return value;
}

// Every catalogue id the character holds, whichever way it was granted. A
// lantern lives in instancedItems, an emote in stackedItems; ownership and the
// no-second-copy rule must see both.
function HeldCatalogIds(row: { stackedItems?: string; instancedItems?: string } | undefined) {
    const held = new Set<string>();
    for (const stack of stacks(row?.stackedItems ?? "[]")) {
        if (stack.quantity > 0) held.add(stack.catalogId);
    }
    for (const instance of instances(row?.instancedItems ?? "[]")) {
        held.add(instance.catalogId);
    }
    return held;
}

// An offer is "owned" when everything it grants is already held: all of its
// items, and all of its entitlements. Entitlement-only offers such as the Hunt
// Pass pass have no items, so items alone cannot decide this. The inventory and
// entitlements are read once per request: a 1.12.0 storefront has thousands of
// offers, and reading them per offer made one request thousands of queries.
function OwnershipMarker(userId: string, characterId: string) {
    const held = HeldCatalogIds(GetDb().select().from(inventory).where(eq(inventory.characterId, characterId)).get());
    const entitled = new Set(GetDb().select().from(entitlements).where(eq(entitlements.userId, userId)).all()
        .filter(row => IsEntitlementActive(row)).map(row => row.entitlement));

    return (offer: any) => {
        if (IsBundle(offer)) return { ...offer, remaining: BoughtThisWindow(GetDb(), userId, offer, Date.now()) ? 0 : 1 };
        if (IsRepeatable(offer)) return { ...offer, remaining: 1 };
        // A timed entitlement (a Slayers Club membership) can always be
        // bought again: it extends the time left.
        if ((offer.entitlements ?? []).some((grant: any) => (grant.duration ?? 0) > 0)) return { ...offer, remaining: 1 };

        const items: { catalogId: string; quantity: number }[] = offer.items ?? [];
        const grants: { name: string }[] = offer.entitlements ?? [];

        const owned = (items.length > 0 || grants.length > 0)
            && items.every(item => held.has(item.catalogId))
            && grants.every(grant => entitled.has(grant.name));

        return { ...offer, remaining: owned ? 0 : 1 };
    };
}

export function GetFreeStoreOffers(userId: string) {
    const char = character(userId);
    return webstoreOffers.map(OwnershipMarker(userId, char.characterId));
}

// Offers for any tag, not just the storefront. The Hunt Pass pass and rank
// skips live under their own tags and still need ownership applied.
export function GetOffersForTag(userId: string, tag: string) {
    const char = character(userId);
    const forTag = (catalog as Record<string, any>)[tag];

    if (!Array.isArray(forTag) || !IsStoreTagOpen(tag)) return [];

    // An offer can sit under more than one tag (an event pass is also listed
    // under huntpass_store); it is listed only while all of its tags are open.
    const marked = forTag.filter(IsOfferOpen).map(WithEventWindow).map(OwnershipMarker(userId, char.characterId));
    // The 1.12 fountain activity's OnStoreQueryCompleted checks the offer's
    // price and dates, but not Remaining. Returning a depleted free offer
    // makes its HUD checkbox uncollected again after login even though the
    // purchase ledger correctly prevents a second claim. An empty daily
    // listing makes IsDailyBonusAvailable false and restores the checkmark.
    // Keep other stores' sold-out offers and single-SKU lookups unchanged.
    return tag === "fountain_daily_free_bundle" ? marked.filter(offer => offer.remaining > 0) : marked;
}

// Single offer lookup. This searched the storefront list only, so any SKU under
// another tag - the Hunt Pass pass - came back 404 and the purchase dialog sat
// spinning with no detail to show.
export function GetOfferById(userId: string, skuId: string) {
    const char = character(userId);
    const offer = offers.find((item: any) => item.id === skuId);

    if (!offer || !IsOfferOpen(offer)) throw new StoreError(404, "Unknown store offer");

    return OwnershipMarker(userId, char.characterId)(WithEventWindow(offer));
}

// What the character holds and which entitlements are active, for the
// "charges for nothing" check.
function Holdings(db: any, userId: string, characterId: string) {
    return {
        held: HeldCatalogIds(db.select().from(inventory).where(eq(inventory.characterId, characterId)).get()),
        active: db.select().from(entitlements).where(eq(entitlements.userId, userId)).all()
            .filter((row: any) => IsEntitlementActive(row))
    };
}

const LimitReached = (offer: any) => new StoreError(409, LimitOf(offer) === "weekly" ? "Already bought this week" : "Already claimed today");
const TooPoor = (currency: string) => new StoreError(409, currency === PLATINUM_WALLET ? "Not enough Platinum" : "Not enough coins");

export function CreateFreePurchase(userId: string, currency: string, skuId: string) {
    const char = character(userId);
    const offer = offerFor(skuId, currency);
    if (BoughtThisWindow(GetDb(), userId, offer, Date.now())) throw LimitReached(offer);
    // Checked again, and charged, when the purchase is confirmed.
    const price = OfferPrice(offer);
    if (price.amount > 0) {
        const { held, active } = Holdings(GetDb(), userId, char.characterId);
        if (GrantsNothing(offer, held, active)) throw new StoreError(409, "Already owned");
        if (WalletBalance(GetDb(), userId, price.currency) < price.amount) throw TooPoor(price.currency);
    }
    const token = randomBytes(32).toString("hex");
    GetDb().insert(storepurchases).values({
        tokenHash: hash(token), userId, characterId: char.characterId, skuId,
        offerHash: offerHash(offer), expiresAt: Date.now() + 10 * 60 * 1000
    }).run();
    return { purchaseToken: token };
}

export function RedeemFreePurchase(userId: string, currency: string, token: unknown) {
    player(userId);
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) {
        throw new StoreError(400, "Invalid purchase token or currency");
    }
    GetDb().transaction(tx => {
        const purchase = tx.select().from(storepurchases).where(eq(storepurchases.tokenHash, hash(token))).get();
        if (!purchase || purchase.userId !== userId) throw new StoreError(403, "Invalid purchase token");
        const char = tx.select().from(characters).where(eq(characters.characterId, purchase.characterId)).get();
        if (!char || char.userId !== userId) throw new StoreError(403, "Purchase character is unavailable");
        // A confirmed request can always be retried after a lost response.
        if (purchase.redeemedAt !== null) return;
        if (purchase.expiresAt < Date.now()) throw new StoreError(410, "Purchase token expired");
        const offer = offerFor(purchase.skuId, currency);
        if (offerHash(offer) !== purchase.offerHash) throw new StoreError(409, "Offer changed; request a new token");
        const items: { catalogId: string; quantity: number }[] = offer.items ?? [];

        // The charge commits with the grant: if anything below fails, the
        // price is not taken, and a confirmed purchase is never charged twice
        // (a retry returns above, at redeemedAt).
        const price = OfferPrice(offer);
        if (price.amount > 0) {
            const { held, active } = Holdings(tx, userId, purchase.characterId);
            if (GrantsNothing(offer, held, active)) throw new StoreError(409, "Already owned");
            try {
                DebitWallet(tx, userId, price.currency, price.amount);
            } catch (error) {
                if (error instanceof InsufficientFundsError) throw TooPoor(price.currency);
                throw error;
            }
        }

        if (IsBundle(offer)) {
            // Checked again here, inside the write transaction: two tokens
            // fetched in one window must not both pay out.
            if (BoughtThisWindow(tx, userId, offer, Date.now(), purchase.tokenHash)) throw LimitReached(offer);
            const stacked = items.filter(item => !IsCurrency(item.catalogId));
            if (stacked.length) {
                ApplyInventoryTransaction(tx, userId, purchase.characterId, `store:${purchase.tokenHash}`, [], stacked, [], [], []);
            }
            for (const item of items.filter(item => IsCurrency(item.catalogId))) {
                CreditWallet(tx, userId, item.catalogId, item.quantity);
            }
        }
        else if (items.length) {
            const row = tx.select().from(inventory).where(eq(inventory.characterId, purchase.characterId)).get();
            const held = HeldCatalogIds(row);
            // Cosmetics are unlocks. Overlapping bundles and fresh tokens must
            // not accumulate extra copies of something the character owns, so
            // anything already held is simply not granted again. Consumables
            // are the exception: every purchase grants the full quantity.
            const toGrant = IsRepeatable(offer) ? items : items.filter(item => !held.has(item.catalogId));

            const stackedToGrant = toGrant.filter(item => GrantKind(item.catalogId) === "stacked");

            // Instanced cosmetics need an identity. Deriving it from the purchase
            // token keeps it stable, so a retried redeem addresses the same
            // instance rather than minting a second lantern.
            const instancedToGrant = toGrant
                .filter(item => GrantKind(item.catalogId) === "instanced")
                .map(item => ({
                    catalogId: item.catalogId,
                    instanceId: hash(`${purchase.tokenHash}:${item.catalogId}`).slice(0, 32),
                    itemData: null,
                    updateVersion: 0
                }));

            // Granted through the shared inventory core rather than writing the
            // table directly, so store purchases get the same replay ledger and
            // quantity validation as every other grant - and inside THIS
            // transaction, so the grant and the receipt still commit together.
            if (stackedToGrant.length || instancedToGrant.length) {
                ApplyInventoryTransaction(tx, userId, purchase.characterId,
                    `store:${purchase.tokenHash}`, instancedToGrant, stackedToGrant, [], [], []);
            }
        }

        const now = Date.now();
        for (const grant of (offer.entitlements ?? []) as { name: string; duration?: number }[]) {
            const duration = grant.duration ?? 0;
            const source = `store:${purchase.skuId}`;
            const where = and(eq(entitlements.userId, userId), eq(entitlements.entitlement, grant.name));
            const already = tx.select().from(entitlements).where(where).get();

            if (!already) {
                tx.insert(entitlements).values({ userId, entitlement: grant.name, duration, activatedAt: now, source }).run();
            }
            else if (duration === 0) {
                // Permanent: already permanent stays as is; a timed one becomes permanent.
                if (already.duration > 0) tx.update(entitlements).set({ duration: 0, activatedAt: now, source }).where(where).run();
            }
            else if (already.duration > 0) {
                // Timed (a Slayers Club membership) stacks: bought while it runs,
                // it adds its hours; bought after it ended, a new term starts now.
                tx.update(entitlements).set(IsEntitlementActive(already, now)
                    ? { duration: already.duration + duration, source }
                    : { duration, activatedAt: now, source }).where(where).run();
            }
        }
        tx.update(storepurchases).set({ redeemedAt: Date.now() })
            .where(eq(storepurchases.tokenHash, purchase.tokenHash)).run();
    }, { behavior: "immediate" });
}
