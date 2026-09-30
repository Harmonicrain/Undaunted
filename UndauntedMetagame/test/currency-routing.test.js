"use strict";
// Which currencies are account wallet balances and which are character
// inventory stacks. The wallet is the live service's balance sheet; the game
// keeps everything else in the inventory and spends it from there (Slayer's
// Path costs Combat Merits), so a grant sent to the wallet could not be used.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Wallet = require("../dist/features/wallet/wallet");
const { ClassifyReward } = require("../dist/features/huntpass/rewards");

test("balance sheet currencies go to the wallet; the rest, and Rams, to the inventory", () => {
    for (const Id of ["CURRENCY_PLATINUM", "CURRENCY_PLATINUM_UNIV", "CURRENCY_MARKS_STEEL", "CURRENCY_PRESTIGE",
        "CURRENCY_CELLDUST", "CURRENCY_TOKEN_EXCHANGE_SPEED_UP", "CURRENCY_S19_COIN"]) {
        assert.equal(Wallet.IsCurrency(Id), true, Id);
    }
    for (const Id of ["CURRENCY_NOTES", "CURRENCY_PJM_WEAPON", "CURRENCY_PJM_PRESTIGE_EMPTY", "CURRENCY_TOKEN_TRANSMOG",
        "TOKEN_BOUNTY_DRAFT_PREMIUM"]) {
        assert.equal(Wallet.IsCurrency(Id), false, Id);
    }
});

test("every balance-sheet currency is routed from gameplay transactions to the wallet", () => {
    for (const Id of ["CURRENCY_CELLDUST", "CURRENCY_TOKEN_EXCHANGE_SPEED_UP", "CURRENCY_PLATINUM_UNIV",
        "id_currency_celldust", "id_currency_token_exchange_speed_up"]) {
        assert.equal(Wallet.IsWalletRoutedCurrency(Id), true, Id);
    }
    for (const Id of ["CURRENCY_NOTES", "CURRENCY_PJM_WEAPON", "CURRENCY_PJM_PRESTIGE_EMPTY"]) {
        assert.equal(Wallet.IsWalletRoutedCurrency(Id), false, Id);
    }
});

test("Ace Chips are only a protocol alias for Aetherdust", () => {
    assert.equal(Wallet.CanonicaliseCurrency("CURRENCY_TOKEN_EXCHANGE_SPEED_UP"), "CURRENCY_CELLDUST");
    assert.equal(Wallet.CanonicaliseCurrency("id_currency_token_exchange_speed_up"), "CURRENCY_CELLDUST");
    assert.deepEqual(Wallet.WalletAliasesFor("CURRENCY_CELLDUST"), ["CURRENCY_CELLDUST", "id_currency_celldust"]);
});

test("a Hunt Pass rank pays Combat Merits into the inventory and platinum into the wallet", () => {
    const { StackedItems, Currencies } = ClassifyReward({ stacked_items: [
        { catalog_id: "CURRENCY_PJM_WEAPON", quantity: 125 },
        { catalog_id: "CURRENCY_PLATINUM_UNIV", quantity: 50 }
    ] });
    assert.deepEqual(StackedItems, [{ catalogId: "CURRENCY_PJM_WEAPON", quantity: 125 }]);
    assert.deepEqual(Currencies, [{ currencyId: "CURRENCY_PLATINUM_UNIV", quantity: 50 }]);
});
