import { CanonicaliseCurrency } from "../wallet/currency";

// What an offer costs, paid from the wallet: platinumPrice in Platinum (Hunt
// Pass ranks and the fountain pay Platinum in), or, for an offer naming a
// priceCurrency, price in that currency - the Reward Cache sells for the
// season's coin (CURRENCY_S19_COIN), which challenges pay in.
export const PLATINUM_WALLET = "CURRENCY_PLATINUM";

export function OfferPrice(offer: any): { currency: string; amount: number } {
    return typeof offer?.priceCurrency === "string"
        ? { currency: CanonicaliseCurrency(offer.priceCurrency), amount: offer.price }
        : { currency: PLATINUM_WALLET, amount: offer?.platinumPrice };
}

// The client names the purchase currency in the token and notification paths:
// 1.4.4 sends "platinum", 1.12.0 the price's currencyId (id_currency_platinum,
// id_currency_s19_coin, ...). A purchase must be paid in the offer's currency.
export function PathCurrency(currency: unknown) {
    const name = String(currency).toLowerCase();
    return CanonicaliseCurrency(name === "platinum" ? PLATINUM_WALLET : name.replace(/^id_/, "").toUpperCase());
}


export const PaysIn = (offer: any, currency: unknown) => PathCurrency(currency) === OfferPrice(offer).currency;
