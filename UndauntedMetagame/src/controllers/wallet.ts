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

export function IsCurrency(CatalogId: string){
    // Rams are held/spent as CURRENCY_NOTES in the 1.4.4 character inventory.
    // Live inventories contain these balances; users.notes is a legacy field.
    // Sending mastery Rams to the account wallet makes them unspendable there.
    return CatalogId.startsWith("CURRENCY_") && CatalogId !== "CURRENCY_NOTES";
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
