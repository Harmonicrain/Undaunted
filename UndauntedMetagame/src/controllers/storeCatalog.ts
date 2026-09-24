import { readFileSync } from "node:fs";
import { join } from "node:path";
import vendorCatalog from "../vendor/store_catalog.json";
import vendorItemKinds from "../vendor/store_item_kinds.json";

// The storefront. Dauntless 1.4.4 ships its catalogue in src/vendor. Another
// client build points STORE_DATA_DIR at a directory holding its own
// store_catalog.json and store_item_kinds.json (1.12.0: generated from the
// running client's item catalogue by tools/Build-Store112.mjs). That data is
// game-derived, so it lives outside the repository.
function Load(): { catalog: Record<string, any>; itemKinds: Record<string, string> } {
    const Dir = process.env.STORE_DATA_DIR;

    if (!Dir) return { catalog: vendorCatalog as Record<string, any>, itemKinds: vendorItemKinds as Record<string, string> };

    return {
        catalog: JSON.parse(readFileSync(join(Dir, "store_catalog.json"), "utf8")),
        itemKinds: JSON.parse(readFileSync(join(Dir, "store_item_kinds.json"), "utf8"))
    };
}

const Loaded = Load();

export const StoreCatalog = Loaded.catalog;

// Grant kind (stacked or instanced) for every item the catalogue sells, and
// nothing else: an item missing here is never granted.
export const StoreItemKinds = Loaded.itemKinds;

// How offers are written on the wire. 1.4.4 reads flat price fields
// (platinumPrice, ...); 1.12.0 reads prices:[{currencyId, price, salesPrice}]
// and has no parser for the flat fields, so it discards flat-priced offers.
export const StoreOfferFormat: "flat" | "prices" = process.env.STORE_OFFER_FORMAT === "prices" ? "prices" : "flat";
