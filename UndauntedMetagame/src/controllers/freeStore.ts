import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { GetDb } from "../db";
import { characters, entitlements, inventory, storepurchases } from "../db/schema";
import { ApplyInventoryTransaction } from "./inventory";
import { StoreCatalog as catalog, StoreItemKinds as itemKinds } from "./storeCatalog";

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

// The client names the purchase currency in the token and notification paths.
// 1.4.4 sends "platinum"; the 1.12.0 offers price in id_currency_platinum.
const PLATINUM = new Set(["platinum", "id_currency_platinum", "currency_platinum"]);
const IsPlatinum = (currency: string) => PLATINUM.has(String(currency).toLowerCase());

// A repeatable offer sells consumables only. It is never "owned", and each
// purchase grants its full quantity again.
function IsRepeatable(offer: any) {
    const items: { catalogId: string }[] = offer.items ?? [];
    return items.length > 0 && items.every(item => REPEATABLE_ITEMS.has(item.catalogId));
}

function offerFor(skuId: string, currency: string) {
    if (!IsPlatinum(currency)) throw new StoreError(400, "Unsupported store currency");
    const offer = offers.find(item => item.id === skuId);
    if (!offer) throw new StoreError(404, "Unknown store offer");
    // Free offers only. Supported grants are permanent cosmetics, repeatable
    // consumables and entitlements; currencies still need their own logic.
    const items: { catalogId: string; quantity: number }[] = offer.items ?? [];
    const grants: { name: string; duration?: number }[] = offer.entitlements ?? [];

    if (offer.platinumPrice !== 0) throw new StoreError(409, "Offer is not free");
    if (!items.length && !grants.length) throw new StoreError(409, "Offer grants nothing");
    const repeatable = IsRepeatable(offer);
    if (repeatable && grants.length) throw new StoreError(409, "Repeatable offers cannot grant entitlements");
    if (items.some(item => GrantKind(item.catalogId) === undefined ||
        REPEATABLE_ITEMS.has(item.catalogId) !== repeatable ||
        (repeatable ? GrantKind(item.catalogId) !== "stacked" || !Number.isSafeInteger(item.quantity) || item.quantity <= 0
            : item.quantity !== 1))) {
        throw new StoreError(409, "Offer is not a supported free item");
    }
    if (grants.some(grant => typeof grant.name !== "string" || !grant.name)) {
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
    const entitled = new Set(GetDb().select({ entitlement: entitlements.entitlement }).from(entitlements)
        .where(eq(entitlements.userId, userId)).all().map(row => row.entitlement));

    return (offer: any) => {
        if (IsRepeatable(offer)) return { ...offer, remaining: 1 };

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

    if (!Array.isArray(forTag)) return [];

    return forTag.map(OwnershipMarker(userId, char.characterId));
}

// Single offer lookup. This searched the storefront list only, so any SKU under
// another tag - the Hunt Pass pass - came back 404 and the purchase dialog sat
// spinning with no detail to show.
export function GetOfferById(userId: string, skuId: string) {
    const char = character(userId);
    const offer = offers.find((item: any) => item.id === skuId);

    if (!offer) throw new StoreError(404, "Unknown store offer");

    return OwnershipMarker(userId, char.characterId)(offer);
}

export function CreateFreePurchase(userId: string, currency: string, skuId: string) {
    const char = character(userId);
    const offer = offerFor(skuId, currency);
    const token = randomBytes(32).toString("hex");
    GetDb().insert(storepurchases).values({
        tokenHash: hash(token), userId, characterId: char.characterId, skuId,
        offerHash: offerHash(offer), expiresAt: Date.now() + 10 * 60 * 1000
    }).run();
    return { purchaseToken: token };
}

export function RedeemFreePurchase(userId: string, currency: string, token: unknown) {
    player(userId);
    if (!IsPlatinum(currency) || typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) {
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

        if (items.length) {
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

        for (const grant of (offer.entitlements ?? []) as { name: string; duration?: number }[]) {
            const already = tx.select().from(entitlements)
                .where(and(eq(entitlements.userId, userId), eq(entitlements.entitlement, grant.name))).get();

            if (!already) {
                tx.insert(entitlements).values({
                    userId,
                    entitlement: grant.name,
                    duration: grant.duration ?? 0,
                    activatedAt: Date.now(),
                    source: `store:${purchase.skuId}`
                }).run();
            }
        }
        tx.update(storepurchases).set({ redeemedAt: Date.now() })
            .where(eq(storepurchases.tokenHash, purchase.tokenHash)).run();
    }, { behavior: "immediate" });
}
