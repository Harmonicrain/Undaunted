import { and, eq } from "drizzle-orm";
import { GetDb } from "../db";
import { wallets } from "../db/schema";
import { CanonicaliseCurrency, WalletAliasesFor } from "../currency";

export { CanonicaliseCurrency, IsCurrency, IsSeasonalCoin, IsWalletRoutedCurrency, WalletAliasesFor } from "../currency";

// Account currency balances.
//
// GET /balance previously answered with a literal zero for every currency
// except notes, so anything that paid out a currency - Hunt Pass ranks pay
// platinum, steel marks and prestige - could never become visible. Currencies
// are account-scoped; inventory is per character, so they cannot live there.

// Synchronous and transaction-scoped, to match ApplyInventoryTransaction: a
// rank claim grants items, currencies and entitlements as one unit, so none of
// these may suspend.
export function CreditWallet(tx: any, UserId: string, CurrencyId: string, Amount: number){
    if(!Number.isSafeInteger(Amount) || Amount <= 0){
        throw new Error(`Refusing to credit ${Amount} of ${CurrencyId}: expected a positive integer`);
    }

    const Canonical = CanonicaliseCurrency(CurrencyId);
    // Historical rewards expressed Ace Chips in units worth four Aetherdust
    // each (25 chips became 100 dust). Keep that conversion at the input
    // boundary; Ace Chips are never stored as an active currency.
    const CreditAmount = CurrencyId.replace(/^id_/, "").toUpperCase() === "CURRENCY_TOKEN_EXCHANGE_SPEED_UP"
        ? Amount * 4 : Amount;

    const Existing = tx.select().from(wallets)
        .where(and(eq(wallets.userId, UserId), eq(wallets.currencyId, Canonical))).get();

    const Updated = (Existing?.amount ?? 0) + CreditAmount;

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
