import { eq } from "drizzle-orm";
import { GetDb } from "../../db";
import { inventory, inventorytransactions } from "../../db/schema";
import { createHash } from "node:crypto";
import { logger } from "../../logger";
import { DoesCharacterBelongToUserId } from "../../controllers/character";
import { CreditWallet, DebitWallet, InsufficientFundsError, IsWalletRoutedCurrency, WalletBalance } from "../wallet/wallet";
import { CanonicaliseCurrency } from "../wallet/currency";

export type InventoryError = "forbidden" | "not_found" | "conflict" | "invalid_inventory_item" | "invalid_inventory_data" | "db_error";
export type InventoryResult<T = void> = { success: true, data?: T } | { success: false, error: InventoryError };

class InventoryConflictError extends Error {
    constructor(message: string){
        super(message);
        this.name = "InventoryConflictError";
    }
}

class InventoryValidationError extends Error {
    constructor(message: string){
        super(message);
        this.name = "InventoryValidationError";
    }
}

function MakeEmptyInventoryRow(CharacterId: string): typeof inventory.$inferInsert {
    return {
        characterId: CharacterId,
        instancedItems: "[]",
        stackedItems: "[]",
    };
}

function FindInstancedItemIndex(InstancedItems: any[], InstanceId: string){
    return InstancedItems.findIndex((Item) => Item.instanceId === InstanceId);
}

const FUSION_CATALOG_ID = "TOKEN_CELL_EXCHANGE";

type FusionData = {
    SlotID: number;
    EndTime: string;
    ResultCell: string;
    ExchangeID: string;
};

function ParseFusionData(Item: any): FusionData {
    let Data: any;
    try { Data = JSON.parse(Item?.itemData); }
    catch { throw new InventoryValidationError("Invalid fusion token"); }

    if(!Number.isInteger(Data?.SlotID) || Data.SlotID < 1 || Data.SlotID > 3 ||
        typeof Data?.EndTime !== "string" || !Number.isFinite(Date.parse(Data.EndTime)) ||
        typeof Data?.ResultCell !== "string" || !Data.ResultCell.startsWith("CELL_") ||
        typeof Data?.ExchangeID !== "string" || Data.ExchangeID.length === 0){
        throw new InventoryValidationError("Invalid fusion token");
    }

    return Data as FusionData;
}

function FusionInstanceId(SlotID: number){
    return `${FUSION_CATALOG_ID}:${SlotID}`;
}

function NormaliseFusionItem(Item: any){
    if(Item?.catalogId !== FUSION_CATALOG_ID) return Item;
    const Data = ParseFusionData(Item);
    Item.instanceId = FusionInstanceId(Data.SlotID);
    return Item;
}

function FindIncomingInstancedItemIndex(InstancedItems: any[], IncomingItem: any){
    const Exact = FindInstancedItemIndex(InstancedItems, IncomingItem.instanceId);
    if(Exact >= 0 || IncomingItem?.catalogId !== FUSION_CATALOG_ID) return Exact;

    // A freshly launched fixed client uses the server-provided per-slot id.
    // Retain a narrow fallback for a token cached before this repair: if its
    // payload identifies a slot/exchange, use that; if only one fusion exists,
    // the legacy fixed id is unambiguous.
    if(IncomingItem?.itemData != null){
        const IncomingData = ParseFusionData(IncomingItem);
        const BySlot = InstancedItems.findIndex((Item) => {
            if(Item?.catalogId !== FUSION_CATALOG_ID) return false;
            const CurrentData = ParseFusionData(Item);
            return CurrentData.SlotID === IncomingData.SlotID || CurrentData.ExchangeID === IncomingData.ExchangeID;
        });
        if(BySlot >= 0) return BySlot;
    }

    if(IncomingItem.instanceId === FUSION_CATALOG_ID){
        const FusionIndexes = InstancedItems.map((Item, Index) => Item?.catalogId === FUSION_CATALOG_ID ? Index : -1)
            .filter((Index) => Index >= 0);
        if(FusionIndexes.length === 1) return FusionIndexes[0];
    }

    return -1;
}

function IsValidFusionSave(CurrentItem: any, IncomingItem: any, Operation: string){
    if(Operation !== "save" && Operation !== "update") return false;
    if(CurrentItem?.catalogId !== FUSION_CATALOG_ID || IncomingItem?.catalogId !== FUSION_CATALOG_ID) return false;
    if(CurrentItem.updateVersion !== IncomingItem.updateVersion) return false;

    const Current = ParseFusionData(CurrentItem);
    const Incoming = ParseFusionData(IncomingItem);
    return Current.SlotID === Incoming.SlotID && Current.ExchangeID === Incoming.ExchangeID &&
        Current.ResultCell === Incoming.ResultCell && Date.parse(Incoming.EndTime) <= Date.parse(Current.EndTime);
}

function HasStatelessItemData(Item: any){
    return !Object.prototype.hasOwnProperty.call(Item, "itemData") || Item.itemData == null;
}

function IsAllowedStaleStatelessReplacement(CurrentItem: any, IncomingItem: any, Operation: string){
    return Operation !== "remove"
        && HasStatelessItemData(CurrentItem)
        && HasStatelessItemData(IncomingItem)
        && CurrentItem.updateVersion === 0;
}

// Stacked quantities arrived unvalidated: a non-numeric or negative quantity
// was applied verbatim, so a negative "add" silently removed items and a
// removal could drive a stack below zero.
function AssertValidStackedQuantity(Item: any, Operation: string){
    const Quantity = Number(Item?.quantity);

    if(!Number.isInteger(Quantity) || Quantity <= 0){
        throw new InventoryValidationError(`Refusing stacked item ${Operation} ${Item?.catalogId}: quantity must be a positive integer, got ${JSON.stringify(Item?.quantity)}`);
    }

    return Quantity;
}

function AssertValidIncomingInstancedItem(IncomingItem: any, Operation: string){
    if(HasStatelessItemData(IncomingItem) && IncomingItem.updateVersion !== 0){
        throw new InventoryValidationError(`Refusing stateless instanced item ${Operation} ${IncomingItem.catalogId}/${IncomingItem.instanceId}: expected updateVersion 0, got ${IncomingItem.updateVersion}`);
    }
}

function AssertExistingInstancedItemWrite(CurrentItem: any, IncomingItem: any, Operation: string): "write" | "skip"{
    if(Operation !== "remove"){
        AssertValidIncomingInstancedItem(IncomingItem, Operation);
    }

    if(typeof CurrentItem.updateVersion !== "number"){
        return "write";
    }

    if(IsAllowedStaleStatelessReplacement(CurrentItem, IncomingItem, Operation)){
        return "skip";
    }

    if(IsValidFusionSave(CurrentItem, IncomingItem, Operation)) return "write";

    const IsStaleInstancedItem = typeof IncomingItem.updateVersion !== "number" || IncomingItem.updateVersion <= CurrentItem.updateVersion;
    if(IsStaleInstancedItem){
        throw new InventoryConflictError(`Refusing stale instanced item ${Operation} ${IncomingItem.catalogId}/${IncomingItem.instanceId}: current updateVersion ${CurrentItem.updateVersion}, incoming updateVersion ${IncomingItem.updateVersion}`);
    }

    return "write";
}

export async function UpdateInstancedItem(CharacterId: string, UserId: string, InstanceId: string, CatalogId: string, ItemData: string | null | undefined, UpdateVersion: number): Promise<InventoryResult<any>>{
    if(!await DoesCharacterBelongToUserId(UserId, CharacterId)){
        logger.error(`Specified characterId ${CharacterId} does not belong to user ${UserId}`);
        return {success: false, error: "forbidden"};
    }

    try{
        return GetDb().transaction((tx) => {
            let CurrentInventory = tx.query.inventory.findFirst({where: eq(inventory.characterId, CharacterId)}).sync();

            if(CurrentInventory == undefined){
                logger.info(`Creating inventory for characterId ${CharacterId} and userId ${UserId}`);

                CurrentInventory = MakeEmptyInventoryRow(CharacterId);

                tx.insert(inventory).values(CurrentInventory).run();
            }

            const InstancedItems: any[] = JSON.parse(CurrentInventory.instancedItems);
            const IncomingItem = NormaliseFusionItem({catalogId: CatalogId, instanceId: InstanceId, itemData: ItemData, updateVersion: UpdateVersion});
            const ItemIndex = FindIncomingInstancedItemIndex(InstancedItems, IncomingItem);

            if(ItemIndex < 0){
                return {success: false, error: "not_found"} as InventoryResult<any>;
            }

            const Item = InstancedItems[ItemIndex];
            if(AssertExistingInstancedItemWrite(Item, IncomingItem, "update") === "skip"){
                logger.info(`Skipping stale stateless Instanced Item ${CatalogId} for CharacterId ${CharacterId} and UserId ${UserId}`);
                return {success: true, data: Item} as InventoryResult<any>;
            }

            InstancedItems[ItemIndex] = IncomingItem;

            logger.info(`Updating Instanced Item ${CatalogId} for CharacterId ${CharacterId} and UserId ${UserId}`);

            tx.update(inventory).set({
                instancedItems: JSON.stringify(InstancedItems)
            }).where(eq(inventory.characterId, CharacterId)).run();

            return {success: true, data: IncomingItem} as InventoryResult<any>;
        });
    }
    catch(error){
        if(error instanceof InventoryConflictError){
            logger.warn(error.message);
            return {success: false, error: "conflict"};
        }

        if(error instanceof InventoryValidationError){
            logger.warn(error.message);
            return {success: false, error: "invalid_inventory_item"};
        }

        if(error instanceof SyntaxError){
            logger.error(error, `Invalid inventory data while updating instanced item ${CatalogId} for characterId ${CharacterId} and userId ${UserId}`);
            return {success: false, error: "invalid_inventory_data"};
        }

        logger.error(error, `Failed to update instanced item ${CatalogId} for characterId ${CharacterId} and userId ${UserId}`);
        return {success: false, error: "db_error"};
    }
}

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

// Async entry point for callers that do not already hold a transaction. Checks
// ownership, opens the transaction, and maps failures onto a result.
export async function RunInventoryTransaction(UserId: string, CharacterId: string, TransactionId: string, InstancedItemsToAdd: any[], StackedItemsToAdd: any[], InstancedItemsToRemove: any[], StackedItemsToRemove: any[], InstancedItemsToSave: any[]): Promise<InventoryResult<any[]>>{
    if(!await DoesCharacterBelongToUserId(UserId, CharacterId)){
        logger.error(`Specified characterId ${CharacterId} does not belong to user ${UserId}`);
        return {success: false, error: "forbidden"};
    }

    try{
        const Result = GetDb().transaction((tx) => ApplyInventoryTransaction(
            tx, UserId, CharacterId, TransactionId,
            InstancedItemsToAdd, StackedItemsToAdd,
            InstancedItemsToRemove, StackedItemsToRemove, InstancedItemsToSave));

        return {success: true, data: Result.TouchedStackedItems};
    }
    catch(error){
        if(error instanceof InventoryConflictError){
            logger.warn(error.message);
            return {success: false, error: "conflict"};
        }

        if(error instanceof InventoryValidationError){
            logger.warn(error.message);
            return {success: false, error: "invalid_inventory_item"};
        }

        if(error instanceof SyntaxError){
            logger.error(error, `Invalid inventory data while running transaction ${TransactionId} for characterId ${CharacterId} and userId ${UserId}`);
            return {success: false, error: "invalid_inventory_data"};
        }

        logger.error(error, `Failed to run inventory transaction ${TransactionId} for characterId ${CharacterId} and userId ${UserId}`);
        return {success: false, error: "db_error"};
    }
}

export async function GetInventoryForUserIdAndCharacterId(UserId: string, CharacterId: string): Promise<InventoryResult<{characterId: string, instancedItems: any[], stackedItems: any[]}>>{
    if(!await DoesCharacterBelongToUserId(UserId, CharacterId)){ // TODO: HACK: Get rid of this ugly thing, this is a workaround as we don't have a userId on our inventories table
        return {success: false, error: "forbidden"};
    }

    try{
        let InventoryFromDb = await GetDb().query.inventory.findFirst({where: eq(inventory.characterId, CharacterId)});

        if(InventoryFromDb == undefined){
            logger.info(`Creating inventory for characterId ${CharacterId} and userId ${UserId}`);

            InventoryFromDb = MakeEmptyInventoryRow(CharacterId);

            await GetDb().insert(inventory).values(InventoryFromDb);
        }

        const InstancedItems: any[] = JSON.parse(InventoryFromDb!.instancedItems);
        let MigratedFusionIds = false;
        for(const Item of InstancedItems){
            if(Item?.catalogId !== FUSION_CATALOG_ID) continue;
            const Before = Item.instanceId;
            NormaliseFusionItem(Item);
            MigratedFusionIds ||= Before !== Item.instanceId;
        }
        if(MigratedFusionIds){
            await GetDb().update(inventory).set({ instancedItems: JSON.stringify(InstancedItems) })
                .where(eq(inventory.characterId, CharacterId));
        }

        // Middleman affordability is checked through InventoryData, whereas
        // the HUD reads /balance. Project the account balance without storing
        // a second copy of the money. An absent stack represents zero.
        const StackedItems = JSON.parse(InventoryFromDb!.stackedItems).filter((Item: any) =>
            CanonicaliseCurrency(Item.catalogId) !== "CURRENCY_CELLDUST");
        const DustBalance = WalletBalance(GetDb(), UserId, "CURRENCY_CELLDUST");
        if(DustBalance > 0) StackedItems.push({ catalogId: "CURRENCY_CELLDUST", quantity: DustBalance });

        return {
            success: true,
            data: {
                characterId: CharacterId,
                instancedItems: InstancedItems,
                stackedItems: StackedItems
            }
        };
    }
    catch(error){
        if(error instanceof SyntaxError){
            logger.error(error, `Invalid inventory data while fetching inventory for characterId ${CharacterId} and userId ${UserId}`);
            return {success: false, error: "invalid_inventory_data"};
        }

        logger.error(error, `Failed to fetch inventory for characterId ${CharacterId} and userId ${UserId}`);
        return {success: false, error: "db_error"};
    }
}
