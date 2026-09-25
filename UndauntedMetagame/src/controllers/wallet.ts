import { and, eq } from "drizzle-orm";
import { GetDb } from "../db";
import { wallets } from "../db/schema";

// Account currency balances.
//
// GET /balance previously answered with a literal zero for every currency
// except notes, so anything that paid out a currency - Hunt Pass ranks pay
// platinum, steel marks and prestige - could never become visible. Currencies
// are account-scoped; inventory is per character, so they cannot live there.

// The client asks for each currency under two spellings, CURRENCY_FOO and
// id_currency_foo. They are the same balance.
export function WalletAliasesFor(CurrencyId: string){
    const Canonical = CanonicaliseCurrency(CurrencyId);

    return [Canonical, `id_${Canonical.toLowerCase()}`];
}

// A handful of catalogue ids do not match the balance key the client reads.
// CURRENCY_PLATINUM_UNIV is how the progression config spells the universal
// platinum reward; the balance sheet calls it CURRENCY_PLATINUM.
const CURRENCY_ALIASES: Record<string, string> = {
    CURRENCY_PLATINUM_UNIV: "CURRENCY_PLATINUM"
};

export function CanonicaliseCurrency(CurrencyId: string){
    return CURRENCY_ALIASES[CurrencyId] ?? CurrencyId;
}

// The currencies the live service kept in its balance service: the GET
// /balance sheet captured from it (routes/store.ts). Only these are account
// wallet balances. Every other CURRENCY_ item is a character inventory stack:
// the 1.12.0 game grants Combat Merits (CURRENCY_PJM_WEAPON) and Aethersparks
// (CURRENCY_PJM_PRESTIGE_EMPTY) into the inventory itself and spends Slayer's
// Path costs from it, so merits credited to the wallet could never be spent.
const BALANCE_CURRENCIES = new Set([
    "CURRENCY_PLATINUM", "CURRENCY_CELLDUST", "CURRENCY_TOKEN_EXCHANGE_SPEED_UP", "CURRENCY_WEAPON_TOKEN",
    "CURRENCY_MARKS_STEEL", "CURRENCY_MARKS_GILDED", "CURRENCY_PRESTIGE", "CURRENCY_REWARDCACHE",
    "CURRENCY_SEASONAL_COIN", "CURRENCY_GAUNTLET_COIN", "CURRENCY_GAUNTLET_COIN_FADED", "CURRENCY_S13_DAILY",
    "CURRENCY_S13_COIN", "CURRENCY_S14_COIN", "CURRENCY_S15_COIN", "CURRENCY_S16_COIN", "CURRENCY_S17_COIN",
    "CURRENCY_S18_COIN", "CURRENCY_S19_COIN", "CURRENCY_S20_COIN",
    "CURRENCY_EVENT_DARKHARVEST", "CURRENCY_EVENT_FROSTFALL", "CURRENCY_EVENT_RAMSGIVING",
    "CURRENCY_EVENT_SAINTSBOND", "CURRENCY_EVENT_SPRINGTIDE"
]);

export function IsCurrency(CatalogId: string){
    // Rams are on the balance sheet too, but are held/spent as CURRENCY_NOTES
    // in the character inventory; users.notes is a legacy field. Sending
    // mastery Rams to the account wallet makes them unspendable there.
    return typeof CatalogId === "string" && BALANCE_CURRENCIES.has(CanonicaliseCurrency(CatalogId));
}

// The seasonal coins (Elemental Coin is CURRENCY_S19_COIN). The 1.12.0
// gameserver pays a claimed challenge's coins into the character inventory,
// but the Reward Cache shows and spends the balance: seen in game, a player
// holding 600 coins in the inventory and 200 in the wallet was shown 200.
export function IsSeasonalCoin(CatalogId: string){
    return typeof CatalogId === "string" && /^CURRENCY_(S\d+_(COIN|DAILY)|REWARDCACHE|SEASONAL_COIN)$/.test(CatalogId);
}

// Synchronous and transaction-scoped, to match ApplyInventoryTransaction: a
// rank claim grants items, currencies and entitlements as one unit, so none of
// these may suspend.
export function CreditWallet(tx: any, UserId: string, CurrencyId: string, Amount: number){
    if(!Number.isSafeInteger(Amount) || Amount <= 0){
        throw new Error(`Refusing to credit ${Amount} of ${CurrencyId}: expected a positive integer`);
    }

    const Canonical = CanonicaliseCurrency(CurrencyId);

    const Existing = tx.select().from(wallets)
        .where(and(eq(wallets.userId, UserId), eq(wallets.currencyId, Canonical))).get();

    const Updated = (Existing?.amount ?? 0) + Amount;

    if(Existing == undefined){
        tx.insert(wallets).values({
            userId: UserId, currencyId: Canonical, amount: Updated, updatedAt: Date.now()
        }).run();
    }
    else{
        tx.update(wallets).set({ amount: Updated, updatedAt: Date.now() })
            .where(and(eq(wallets.userId, UserId), eq(wallets.currencyId, Canonical))).run();
    }

    return Updated;
}

export function WalletBalance(tx: any, UserId: string, CurrencyId: string){
    return tx.select().from(wallets)
        .where(and(eq(wallets.userId, UserId), eq(wallets.currencyId, CanonicaliseCurrency(CurrencyId)))).get()?.amount ?? 0;
}

export class InsufficientFundsError extends Error {}

// The spending side, for priced store offers. Transaction-scoped like
// CreditWallet, so a purchase's charge and its grant commit or roll back
// together. A balance never goes below zero.
export function DebitWallet(tx: any, UserId: string, CurrencyId: string, Amount: number){
    if(!Number.isSafeInteger(Amount) || Amount <= 0){
        throw new Error(`Refusing to debit ${Amount} of ${CurrencyId}: expected a positive integer`);
    }

    const Canonical = CanonicaliseCurrency(CurrencyId);
    const Balance = WalletBalance(tx, UserId, Canonical);

    if(Balance < Amount){
        throw new InsufficientFundsError(`${UserId} has ${Balance} ${Canonical}, needs ${Amount}`);
    }

    tx.update(wallets).set({ amount: Balance - Amount, updatedAt: Date.now() })
        .where(and(eq(wallets.userId, UserId), eq(wallets.currencyId, Canonical))).run();

    return Balance - Amount;
}

export function GetWallet(UserId: string): Record<string, number> {
    const Rows = GetDb().select().from(wallets).where(eq(wallets.userId, UserId)).all();

    const Balances: Record<string, number> = {};

    for(const Row of Rows){
        for(const Key of WalletAliasesFor(Row.currencyId)){
            Balances[Key] = Row.amount;
        }
    }

    return Balances;
}
