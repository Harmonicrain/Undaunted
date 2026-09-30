import { createHash } from "node:crypto";
import { WeeklyChallengeWindowStart } from "./weeklyChallenges";

const WeekMilliseconds = 7 * 24 * 60 * 60 * 1000;
const RotationEpoch = Date.UTC(1970, 0, 1, 18); // Thursday, like weekly challenges.

export function IsRotatingMiddlemanOffer(offer: any): boolean {
    return offer?._middlemanFamily != undefined;
}

export function MiddlemanOfferWindow(offer: any, now = new Date()) {
    if (!IsRotatingMiddlemanOffer(offer)) return offer;
    const start = WeeklyChallengeWindowStart(now);
    return { ...offer, availableFrom: new Date(start).toISOString(),
        availableTo: new Date(start + WeekMilliseconds).toISOString() };
}

export function SelectWeeklyMiddlemanOffers(pool: any[], now = new Date()): any[] {
    const rotating = pool.filter(IsRotatingMiddlemanOffer);
    // Manually configured fixed offerings retain their own behaviour.
    if (!rotating.length) return pool;
    const families = [...new Set<string>(rotating.map(offer => offer._middlemanFamily))]
        .map(id => ({ id, score: createHash("sha256").update(`middleman-weekly-v1:${id}`).digest("hex") }))
        .sort((a, b) => a.score.localeCompare(b.score))
        .map(row => row.id);
    const week = Math.floor((WeeklyChallengeWindowStart(now) - RotationEpoch) / WeekMilliseconds);
    const offset = ((week * 3) % families.length + families.length) % families.length;
    // Advance three different cell families each week. With six or more
    // families, none of this week's cells reappear the following week.
    return Array.from({ length: Math.min(3, families.length) }, (_, index) => {
        const family = families[(offset + index) % families.length];
        const rank = index === 2 ? 2 : 1;
        const offer = rotating.find(row => row._middlemanFamily === family && row._middlemanRank === rank);
        return offer ? { ...MiddlemanOfferWindow(offer, now), displayPriority: index } : undefined;
    }).filter(offer => offer != undefined);
}

// 1.12 native IsExchangeSlotLocked checks exchange_slot_<SlotID>.
export function AddMiddlemanOffers(catalog: Record<string, any>, itemKinds: Record<string, string>) {
    if (process.env.STORE_OFFER_FORMAT !== "prices") return catalog;
    const result = { ...catalog };
    for (const slot of [2, 3]) {
        const tag = `exchange_vendor_slot_${slot}`;
        result[tag] = [{ id: `single_exchange_slot_${slot}`, displayName: `Fusion Slot ${slot}`,
            displayDescription: "Permanently unlock an additional cell fusion slot.",
            displayPriority: slot, tags: [tag], platinumPrice: 0, items: [],
            entitlements: [{ name: `exchange_slot_${slot}`, duration: 0 }], maxAllowed: 1, remaining: 1 }];
    }
    // The item dump also contains obsolete prototypes. Require the localized
    // gameplay name (+1/+2 ... Cell), a stackable grant and both normal ranks.
    const source: any[] = catalog.webstore ?? [];
    const families = new Map<string, Map<number, any>>();
    for (const offer of source) {
        if (offer.items?.length !== 1 || offer.items[0].quantity !== 1) continue;
        const id = offer.items[0].catalogId;
        if (typeof id !== "string" || itemKinds[id] !== "stacked") continue;
        const match = /^(CELL_.+)_(UC|R)$/.exec(id);
        if (!match) continue;
        const rank = match[2] === "UC" ? 1 : 2;
        if (!new RegExp(`^\\+${rank} .+ Cell$`).test(offer.displayName ?? "")) continue;
        if (!families.has(match[1])) families.set(match[1], new Map());
        families.get(match[1])!.set(rank, offer);
    }
    result.weekly_cell_offering = [...families.entries()].flatMap(([family, ranks]) => {
        if (ranks.size !== 2) return [];
        return [...ranks.entries()].map(([rank, original]) => ({ ...original,
            id: `middleman_weekly_${original.items[0].catalogId.toLowerCase()}`, tags: ["weekly_cell_offering"],
            displayDescription: "Purchase one cell with Aetherdust.",
            priceCurrency: "CURRENCY_CELLDUST", price: rank === 2 ? 200 : 80,
            repeatable: true, platinumPrice: null, maxAllowed: 1, remaining: 1,
            entitlements: [], _middlemanFamily: family, _middlemanRank: rank }));
    });
    return result;
}
