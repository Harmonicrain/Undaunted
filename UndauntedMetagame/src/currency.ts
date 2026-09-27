// Currency ids backed by the account balance service in the 1.12 client.
// Keep this module free of database imports so startup data repairs and normal
// wallet operations use exactly the same classification rules.

const CURRENCY_ALIASES: Record<string, string> = {
    CURRENCY_PLATINUM_UNIV: "CURRENCY_PLATINUM"
};

const BALANCE_CURRENCIES = new Set([
    "CURRENCY_PLATINUM", "CURRENCY_CELLDUST", "CURRENCY_TOKEN_EXCHANGE_SPEED_UP", "CURRENCY_WEAPON_TOKEN",
    "CURRENCY_MARKS_STEEL", "CURRENCY_MARKS_GILDED", "CURRENCY_PRESTIGE", "CURRENCY_REWARDCACHE",
    "CURRENCY_SEASONAL_COIN", "CURRENCY_GAUNTLET_COIN", "CURRENCY_GAUNTLET_COIN_FADED", "CURRENCY_S13_DAILY",
    "CURRENCY_S13_COIN", "CURRENCY_S14_COIN", "CURRENCY_S15_COIN", "CURRENCY_S16_COIN", "CURRENCY_S17_COIN",
    "CURRENCY_S18_COIN", "CURRENCY_S19_COIN", "CURRENCY_S20_COIN",
    "CURRENCY_EVENT_DARKHARVEST", "CURRENCY_EVENT_FROSTFALL", "CURRENCY_EVENT_RAMSGIVING",
    "CURRENCY_EVENT_SAINTSBOND", "CURRENCY_EVENT_SPRINGTIDE"
]);

export function CanonicaliseCurrency(CurrencyId: string){
    if(typeof CurrencyId !== "string"){
        return CurrencyId;
    }

    // GET /balance exposes both CURRENCY_FOO and id_currency_foo. Accept
    // either spelling on mutations while storing only the canonical key.
    const Normalised = CurrencyId.startsWith("id_")
        ? CurrencyId.slice(3).toUpperCase()
        : CurrencyId;

    return CURRENCY_ALIASES[Normalised] ?? Normalised;
}

export function WalletAliasesFor(CurrencyId: string){
    const Canonical = CanonicaliseCurrency(CurrencyId);

    return [Canonical, `id_${Canonical.toLowerCase()}`];
}

export function IsCurrency(CatalogId: string){
    // Rams are on the balance response too, but the game holds and spends
    // CURRENCY_NOTES in character inventory. Combat Merits and Aethersparks
    // are likewise character-scoped in 1.12 and deliberately absent here.
    return typeof CatalogId === "string" && BALANCE_CURRENCIES.has(CanonicaliseCurrency(CatalogId));
}

export function IsSeasonalCoin(CatalogId: string){
    const Canonical = CanonicaliseCurrency(CatalogId);
    return typeof Canonical === "string" && /^CURRENCY_(S\d+_(COIN|DAILY)|REWARDCACHE|SEASONAL_COIN)$/.test(Canonical);
}

// Every balance-sheet currency is account-scoped. Gameplay servers express
// grants and spends as stacked inventory mutations, so those mutations must be
// redirected to the same wallet that GET /balance displays.
export function IsWalletRoutedCurrency(CatalogId: string){
    return IsCurrency(CatalogId);
}
