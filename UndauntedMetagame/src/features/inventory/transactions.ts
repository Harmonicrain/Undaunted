// Item grants, wallet changes and the replay receipt commit in one caller-owned transaction.
import { eq } from "drizzle-orm";
import { inventory, inventorytransactions } from "../../db/schema";
import { createHash } from "node:crypto";
import { logger } from "../../logger";
import { CanonicaliseCurrency, CreditWallet, DebitWallet, InsufficientFundsError, WalletBalance, IsWalletRoutedCurrency } from "../wallet/wallet";
import { InventoryConflictError, InventoryValidationError } from "./types";
import { MakeEmptyInventoryRow, AssertValidStackedQuantity, AssertValidIncomingInstancedItem, AssertExistingInstancedItemWrite } from "./items";
import { FUSION_CATALOG_ID, ParseFusionData, NormaliseFusionItem, FindIncomingInstancedItemIndex } from "../middleman/fusion";

// The inventory mutation itself, synchronous and transaction-scoped.
//
// better-sqlite3 transactions are synchronous, so a caller that already holds
// one (the store redeem path) cannot await anything inside it - an async helper
// would suspend and the transaction would commit before the writes ran. This
// core therefore does no awaiting and takes the caller's transaction, so
// inventory changes, the replay ledger and whatever else the caller is doing
// all commit or roll back as one unit.
//
// Ownership is NOT checked here. The caller must have verified that the
// character belongs to the account before opening its transaction.
export function ApplyInventoryTransaction(tx: any, UserId: string, CharacterId: string, TransactionId: string, InstancedItemsToAdd: any[], StackedItemsToAdd: any[], InstancedItemsToRemove: any[], StackedItemsToRemove: any[], InstancedItemsToSave: any[]): {TouchedStackedItems: any[], Replayed: boolean}{
    InstancedItemsToAdd ??= [];
    StackedItemsToAdd ??= [];
    InstancedItemsToRemove ??= [];
    StackedItemsToRemove ??= [];
    InstancedItemsToSave ??= [];

    let TouchedStackedItems: any[] = [];

    const ShouldTouchInstancedItems = InstancedItemsToAdd.length > 0 || InstancedItemsToRemove.length > 0 || InstancedItemsToSave.length > 0;
    const ShouldTouchStackedItems = StackedItemsToAdd.length > 0 || StackedItemsToRemove.length > 0;

    if(!ShouldTouchInstancedItems && !ShouldTouchStackedItems){
        return {TouchedStackedItems: [], Replayed: false};
    }

    const HasTransactionId = typeof TransactionId === "string" && TransactionId.length > 0;

    const RequestHash = createHash("sha256").update(JSON.stringify({
        UserId, CharacterId,
        InstancedItemsToAdd, StackedItemsToAdd,
        InstancedItemsToRemove, StackedItemsToRemove, InstancedItemsToSave
    })).digest("hex");

    let ReplayedResult: any[] | undefined = undefined;

            if(HasTransactionId){
                const AlreadyApplied = tx.select().from(inventorytransactions)
                    .where(eq(inventorytransactions.transactionId, TransactionId)).all()[0];

                if(AlreadyApplied != undefined){
                    if(AlreadyApplied.requestHash !== RequestHash){
                        throw new InventoryConflictError(`Refusing transaction ${TransactionId} for characterId ${CharacterId}: the id was already applied with different content`);
                    }

                    logger.info(`Replaying stored result for transaction ${TransactionId} - already applied, not granting again`);

                    ReplayedResult = JSON.parse(AlreadyApplied.result);

                    // Already applied: hand back the stored result without
                    // granting anything a second time.
                    return {TouchedStackedItems: ReplayedResult as any[], Replayed: true};
                }
            }

            // Account balance currencies arrive from gameservers as stacked
            // inventory mutations, but the client displays and spends them
            // through GET /balance. Route every balance-sheet currency to the
            // wallet after the replay check, so a retry cannot pay twice.
            const CurrencyTouched: string[] = [];
            const ToWallet = (Item: any) => IsWalletRoutedCurrency(Item?.catalogId);

            for(const ItemToRemove of StackedItemsToRemove.filter(ToWallet)){
                const Quantity = AssertValidStackedQuantity(ItemToRemove, "remove");
                const Canonical = CanonicaliseCurrency(ItemToRemove.catalogId);

                try{
                    DebitWallet(tx, UserId, Canonical, Quantity);
                }
                catch(error){
                    if(error instanceof InsufficientFundsError){
                        throw new InventoryValidationError(`Refusing to remove ${Quantity} of ${ItemToRemove.catalogId} for characterId ${CharacterId}: ${error.message}`);
                    }
                    throw error;
                }
                CurrencyTouched.push(Canonical);
            }

            for(const ItemToAdd of StackedItemsToAdd.filter(ToWallet)){
                CreditWallet(tx, UserId, ItemToAdd.catalogId, AssertValidStackedQuantity(ItemToAdd, "add"));
                CurrencyTouched.push(CanonicaliseCurrency(ItemToAdd.catalogId));
            }

            const StackedToRemove = StackedItemsToRemove.filter((Item) => !ToWallet(Item));
            const StackedToAdd = StackedItemsToAdd.filter((Item) => !ToWallet(Item));
            const ShouldTouchInventoryStacks = StackedToRemove.length > 0 || StackedToAdd.length > 0;

            let CurrentInventory = tx.query.inventory.findFirst({where: eq(inventory.characterId, CharacterId)}).sync();

            if(CurrentInventory == undefined){
                logger.info(`Creating inventory for characterId ${CharacterId}`)

                CurrentInventory = MakeEmptyInventoryRow(CharacterId);

                tx.insert(inventory).values(CurrentInventory).run();
            }

            const Update: Partial<typeof inventory.$inferInsert> = {};

            if(ShouldTouchInstancedItems){
                const InstancedItems: any[] = JSON.parse(CurrentInventory.instancedItems);
                let DidUpdateInstancedItems = false;

                for(const ItemToRemove of InstancedItemsToRemove){
                    if(ItemToRemove?.catalogId === FUSION_CATALOG_ID && ItemToRemove?.itemData != null) NormaliseFusionItem(ItemToRemove);
                    const ItemIndex = FindIncomingInstancedItemIndex(InstancedItems, ItemToRemove);

                    // Native fusion completion consumes the token at its current
                    // version (including zero). Validate its saved result and time,
                    // and require the token to exist, before granting the cell.
                    const IsFusion = ItemToRemove.catalogId === "TOKEN_CELL_EXCHANGE";
                    if (IsFusion) {
                        const Current = InstancedItems[ItemIndex];
                        if (!Current || Current.catalogId !== ItemToRemove.catalogId ||
                            Current.updateVersion !== ItemToRemove.updateVersion)
                            throw new InventoryConflictError("Fusion token missing or changed");
                        const Data = ParseFusionData(Current);
                        const End = Date.parse(Data?.EndTime);
                        if (!Number.isFinite(End) || End > Date.now() || typeof Data?.ExchangeID !== "string" ||
                            typeof Data?.ResultCell !== "string" || !Data.ResultCell.startsWith("CELL_") ||
                            StackedItemsToAdd.length !== 1 || StackedItemsToAdd[0].catalogId !== Data.ResultCell ||
                            StackedItemsToAdd[0].quantity !== 1 || InstancedItemsToAdd.length || InstancedItemsToSave.length ||
                            InstancedItemsToRemove.length !== 1)
                            throw new InventoryValidationError("Fusion is not complete or reward does not match");
                    }

                    if(ItemIndex >= 0){
                        if (!IsFusion) AssertExistingInstancedItemWrite(InstancedItems[ItemIndex], ItemToRemove, "remove");
                        InstancedItems.splice(ItemIndex, 1);
                        DidUpdateInstancedItems = true;
                    }
                }

                for(const ItemToSave of InstancedItemsToSave){
                    NormaliseFusionItem(ItemToSave);
                    const ItemIndex = FindIncomingInstancedItemIndex(InstancedItems, ItemToSave);

                    if(ItemIndex >= 0){
                        if(AssertExistingInstancedItemWrite(InstancedItems[ItemIndex], ItemToSave, "save") === "skip"){
                            continue;
                        }

                        InstancedItems[ItemIndex] = ItemToSave;
                        DidUpdateInstancedItems = true;
                    }
                    else{
                        AssertValidIncomingInstancedItem(ItemToSave, "save");
                        InstancedItems.push(ItemToSave);
                        DidUpdateInstancedItems = true;
                    }
                }

                for(const ItemToAdd of InstancedItemsToAdd){
                    NormaliseFusionItem(ItemToAdd);
                    const ItemIndex = FindIncomingInstancedItemIndex(InstancedItems, ItemToAdd);

                    if(ItemIndex >= 0){
                        if(AssertExistingInstancedItemWrite(InstancedItems[ItemIndex], ItemToAdd, "add") === "skip"){
                            continue;
                        }

                        InstancedItems[ItemIndex] = ItemToAdd;
                        DidUpdateInstancedItems = true;
                    }
                    else{
                        AssertValidIncomingInstancedItem(ItemToAdd, "add");
                        InstancedItems.push(ItemToAdd);
                        DidUpdateInstancedItems = true;
                    }
                }

                if(DidUpdateInstancedItems){
                    Update.instancedItems = JSON.stringify(InstancedItems);
                }
            }

            if(ShouldTouchInventoryStacks){
                const StackedItems: any[] = JSON.parse(CurrentInventory.stackedItems);

                // Every stack this transaction changed, in first-touched order.
                // The response reports each one's final quantity; removals used
                // to be applied to storage but left out, so the client kept
                // showing pre-crafting balances.
                const ChangedCatalogIds: string[] = [];
                const MarkChanged = (CatalogId: string) => {
                    if(!ChangedCatalogIds.includes(CatalogId)){
                        ChangedCatalogIds.push(CatalogId);
                    }
                };

                for(const ItemToRemove of StackedToRemove){
                    const QuantityToRemove = AssertValidStackedQuantity(ItemToRemove, "remove");

                    const ItemIndex = StackedItems.findIndex((Item) => Item.catalogId === ItemToRemove.catalogId);

                    if(ItemIndex < 0){
                        // Pre-existing behaviour: removing something not held is a
                        // no-op. Left alone deliberately - the client is known to do
                        // this and tightening it without gameplay evidence risks
                        // breaking crafting. Logged so it stops being invisible.
                        logger.warn(`Ignoring removal of ${ItemToRemove.catalogId} for characterId ${CharacterId}: not held`);
                        continue;
                    }

                    const HeldQuantity = Number(StackedItems[ItemIndex].quantity);

                    if(!Number.isFinite(HeldQuantity) || HeldQuantity < QuantityToRemove){
                        throw new InventoryValidationError(`Refusing to remove ${QuantityToRemove} of ${ItemToRemove.catalogId} for characterId ${CharacterId}: only ${StackedItems[ItemIndex].quantity} held`);
                    }

                    StackedItems[ItemIndex].quantity = HeldQuantity - QuantityToRemove;
                    MarkChanged(ItemToRemove.catalogId);

                    if(StackedItems[ItemIndex].quantity <= 0){
                        StackedItems.splice(ItemIndex, 1);
                    }
                }

                for(const ItemToAdd of StackedToAdd){
                    const QuantityToAdd = AssertValidStackedQuantity(ItemToAdd, "add");

                    const ItemIndex = StackedItems.findIndex((Item) => Item.catalogId === ItemToAdd.catalogId);

                    if(ItemIndex >= 0){
                        StackedItems[ItemIndex].quantity = Number(StackedItems[ItemIndex].quantity) + QuantityToAdd;
                    }
                    else{
                        StackedItems.push(ItemToAdd);
                    }

                    MarkChanged(ItemToAdd.catalogId);
                }

                // Final quantities, copied so later mutation cannot alter what
                // was reported or stored for replay. A stack that was used up
                // is reported at zero rather than silently omitted.
                TouchedStackedItems = ChangedCatalogIds.map((CatalogId) => {
                    const Final = StackedItems.find((Item) => Item.catalogId === CatalogId);

                    return Final != undefined ? { ...Final, quantity: Number(Final.quantity) } : { catalogId: CatalogId, quantity: 0 };
                });

                Update.stackedItems = JSON.stringify(StackedItems);
            }

            for(const CatalogId of [...new Set(CurrencyTouched)]){
                TouchedStackedItems.push({ catalogId: CatalogId, quantity: WalletBalance(tx, UserId, CatalogId) });
            }

            if(Object.keys(Update).length > 0){
                tx.update(inventory).set(Update).where(eq(inventory.characterId, CharacterId)).run();
            }

            // Written inside the same transaction as the mutation, so a crash
            // between applying and replying cannot leave the work done but
            // unrecorded - the retry would otherwise grant a second time.
            if(HasTransactionId){
                tx.insert(inventorytransactions).values({
                    transactionId: TransactionId,
                    userId: UserId,
                    characterId: CharacterId,
                    requestHash: RequestHash,
                    result: JSON.stringify(TouchedStackedItems),
                    appliedAt: new Date().toISOString()
                }).run();
            }

    return {
        TouchedStackedItems: ReplayedResult != undefined ? ReplayedResult : TouchedStackedItems,
        Replayed: ReplayedResult != undefined
    };
}
