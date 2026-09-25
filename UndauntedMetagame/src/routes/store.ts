import { Router } from "express";
import { logger } from "../logger";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { GetNotesForUser } from "../controllers/store";
import { GetWallet } from "../controllers/wallet";
import { StoreCatalog as storeCatalog, StoreOfferFormat } from "../controllers/storeCatalog";
import { CreateFreePurchase, GetFreeStoreOffers, GetOfferById, GetOffersForTag, OfferPrice, RedeemFreePurchase, StoreError } from "../controllers/freeStore";
import { RequestHandler } from "express";

export const storeRouter = Router();

storeRouter.post("/reconcile", HasUndauntedMetagameAuth, async (req: any, res) => {
    const Notes = await GetNotesForUser(req.AuthData.userId);

    logger.info(`Retrieved notes balance of ${Notes} for ${req.AuthData.userId}`);

    res.status(200);
    res.json({
        balances: {
            id_currency_notes: Notes,
            CURRENCY_NOTES: Notes,
            ...GetWallet(req.AuthData.userId)
        },
        refreshInventory: true
    });
});

storeRouter.get("/creator", HasUndauntedMetagameAuth, async (req: any, res) => {
    logger.info("SupportACreator (stubbed)");

    res.status(200);
    res.json({
        "expirationDate": "2099-01-01T01:00:00.041Z",
        "slug": "MROWMROW",
        "success": true
    });
})

storeRouter.get("/balance", HasUndauntedMetagameAuth, async (req: any, res) => {
    const UserId = req.AuthData.userId;

    const NotesBalance = await GetNotesForUser(UserId);

    logger.info(`Fetched notes balance of ${NotesBalance} for userId ${UserId}`);

    res.status(200);
    res.json({
        id_currency_s20_coin: 0,
        CURRENCY_GAUNTLET_COIN_FADED: 0,
        CURRENCY_S20_COIN: 0,
        CURRENCY_S18_COIN: 0,
        id_currency_seasonal_coin: 0,
        id_currency_s18_coin: 0,
        id_currency_weapon_token: 25,
        id_currency_celldust: 0,
        id_currency_event_ramsgiving: 0,
        CURRENCY_NOTES: NotesBalance,
        id_currency_event_frostfall: 0,
        CURRENCY_EVENT_DARKHARVEST: 0,
        CURRENCY_S19_COIN: 0,
        id_currency_s16_coin: 0,
        CURRENCY_S16_COIN: 0,
        id_currency_gauntlet_coin: 0,
        id_currency_s13_coin: 0,
        CURRENCY_MARKS_STEEL: 0,
        CURRENCY_S13_COIN: 0,
        CURRENCY_EVENT_FROSTFALL: 0,
        CURRENCY_GAUNTLET_COIN: 0,
        id_currency_marks_steel: 0,
        id_currency_rewardcache: 0,
        CURRENCY_PRESTIGE: 0,
        CURRENCY_SEASONAL_COIN: 0,
        CURRENCY_REWARDCACHE: 0,
        id_currency_token_exchange_speed_up: 0,
        id_currency_event_springtide: 0,
        CURRENCY_TOKEN_EXCHANGE_SPEED_UP: 0,
        id_currency_gauntlet_coin_faded: 0,
        CURRENCY_S15_COIN: 0,
        CURRENCY_PLATINUM: 0,
        id_currency_platinum: 0,
        id_currency_s15_coin: 0,
        id_currency_marks_gilded: 0,
        id_currency_event_darkharvest: 0,
        id_currency_event_saintsbond: 0,
        CURRENCY_EVENT_SPRINGTIDE: 0,
        id_currency_s19_coin: 0,
        id_currency_notes: NotesBalance,
        id_currency_prestige: 0,
        id_currency_s13_daily: 0,
        CURRENCY_WEAPON_TOKEN: 25,
        CURRENCY_MARKS_GILDED: 0,
        CURRENCY_S13_DAILY: 0,
        CURRENCY_CELLDUST: 0,
        CURRENCY_S14_COIN: 0,
        CURRENCY_EVENT_SAINTSBOND: 0,
        CURRENCY_S17_COIN: 0,
        id_currency_s14_coin: 0,
        CURRENCY_EVENT_RAMSGIVING: 0,
        id_currency_s17_coin: 0,
        // Stored balances overlay the zeroed sheet. Hunt Pass ranks pay out
        // platinum, steel marks and prestige, and before the wallet existed
        // those grants had nowhere to go and never became visible here.
        ...GetWallet(UserId)
    });
});

// The client fetches the catalogue by tag. Observed tags on 1.4.4:
//   webstore                    the main storefront
//   season09b_pass              Elite for the active Hunt Pass (BuyPremiumSKU)
//   season09b_rank              Hunt Pass rank skips     (BuyLevelSKU)
//   loadout_slots               additional loadout slots
//   fountain_daily_free_bundle  the daily free bundle
//
// The 1.4.4 client needs flat price fields AND its own category tags (e.g.
// feature, skin_armour). A 200 response with only webstore-tagged offers leaves
// the store without visible categories. Verified in the running client.
// Tags come from src/vendor/store_catalog.json (or STORE_DATA_DIR) so an owner
// can add offers without editing TypeScript. Keys starting with "_" are
// documentation.
const StoreCatalog = storeCatalog as Record<string, any>;

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
        currencyId: `id_${Price.currency.toLowerCase()}`,
        price: Price.amount ?? 0,
        salesPrice: Price.currency === "CURRENCY_PLATINUM" ? offer.platinumSalePrice ?? null : null
    };
}

function ToPricesFormat(offer: any){
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

const ToWire = (offer: any) => StoreOfferFormat === "prices" ? ToPricesFormat(offer) : offer;

const KNOWN_STORE_TAGS = Object.keys(StoreCatalog).filter((Key) => !Key.startsWith("_"));

const StoreAction = (handler: RequestHandler): RequestHandler => (req: any, res, next) => {
    try {
        if (typeof req.AuthData?.userId !== "string") throw new StoreError(401, "Player authentication required");
        return handler(req, res, next);
    } catch (error) {
        if (error instanceof StoreError) {
            res.status(error.status).json({ code: String(error.status), message: error.message });
        } else {
            logger.error({ err: error }, "Store request failed");
            res.status(500).json({ code: "500", message: "Store request failed" });
        }
    }
};

storeRouter.get("/product/sku/:skuId", HasUndauntedMetagameAuth, StoreAction((req: any, res) => {
    res.json(ToWire(GetOfferById(req.AuthData.userId, req.params.skuId)));
}));

storeRouter.get("/token/:currency/:skuId", HasUndauntedMetagameAuth, StoreAction((req: any, res) => {
    res.json(CreateFreePurchase(req.AuthData.userId, req.params.currency, req.params.skuId));
}));

storeRouter.post("/notification/:currency", HasUndauntedMetagameAuth, StoreAction((req: any, res) => {
    RedeemFreePurchase(req.AuthData.userId, req.params.currency, req.query.token);
    res.status(204).send();
}));

storeRouter.get("/product/skus/public", HasUndauntedMetagameAuth, StoreAction((req: any, res) => {
    const RequiredTags = req.query.requiredTags;

    // Matches the documented behaviour of the original service.
    if(RequiredTags == undefined || String(RequiredTags).length === 0){
        logger.warn("Store SKU request with no requiredTags");

        res.status(400);
        res.json({
            code: "400",
            message: "missing requiredTags query parameter"
        });

        return;
    }

    const Tag = String(RequiredTags);
    const Offers = Tag === "webstore" ? GetFreeStoreOffers(req.AuthData.userId)
        : GetOffersForTag(req.AuthData.userId, Tag);

    if(!KNOWN_STORE_TAGS.includes(Tag)){
        logger.warn(`Store SKUs requested for unknown tag ${Tag} - returning an empty catalogue`);
    }
    else{
        logger.info(`Store SKUs for tag ${Tag} - returning ${Offers.length} offer(s)`);
    }

    res.status(200);
    res.json(Offers.map(ToWire));
}));
