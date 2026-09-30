import { OfferPrice } from "../../features/store/pricing";

// 1.12.0 wire shape, the field set its executable parses: prices as
// [{currencyId, price, salesPrice}] priced in the store's own currency ids
// (id_currency_platinum, ...), images {standard, feature}, and a progression
// grant it names skuProgression. The flat 1.4.4 price fields are not sent: the
// 1.12.0 client has no parser for them.
// The offer's price in its own currency: Platinum, or the seasonal coin a
// Reward Cache offer is sold for (CURRENCY_S19_COIN -> id_currency_s19_coin).
function PriceFor(offer: any){
    const Price = OfferPrice(offer);
    return {
        // FCellOfferViewModel's native converter explicitly looks up this
        // uppercase key for its Aetherdust price. Other store currencies use
        // the id_currency_* spelling.
        currencyId: Price.currency === "CURRENCY_CELLDUST"
            ? "CURRENCY_CELLDUST" : `id_${Price.currency.toLowerCase()}`,
        price: Price.amount ?? 0,
        salesPrice: Price.currency === "CURRENCY_PLATINUM" ? offer.platinumSalePrice ?? null : null
    };
}

export function ToPricesFormat(offer: any){
    return {
        id: offer.id,
        displayName: offer.displayName,
        displayDescription: offer.displayDescription,
        displayPriority: offer.displayPriority,
        prices: [PriceFor(offer)],
        maxAllowed: offer.maxAllowed,
        remaining: offer.remaining,
        images: {},
        tags: offer.tags,
        items: offer.items ?? [],
        entitlements: offer.entitlements ?? [],
        skuProgression: null,
        loadoutSlots: offer.loadoutSlots ?? null,
        availableFrom: offer.availableFrom ?? null,
        availableTo: offer.availableTo ?? null,
        timeAvailabilityReason: offer.timeAvailabilityReason ?? null,
        platformOfferId: offer.platformOfferId ?? null,
        missingEntitlementNames: offer.missingEntitlementNames ?? null
    };
}
