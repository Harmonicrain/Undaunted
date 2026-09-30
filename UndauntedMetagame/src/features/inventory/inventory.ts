import { InventoryConflictError, InventoryValidationError, InventoryResult } from "./types";
import { MakeEmptyInventoryRow, AssertExistingInstancedItemWrite } from "./items";
import { FUSION_CATALOG_ID, NormaliseFusionItem, FindIncomingInstancedItemIndex } from "../middleman/fusion";
import { ApplyInventoryTransaction } from "./transactions";
export { ApplyInventoryTransaction } from "./transactions";
export type { InventoryError, InventoryResult } from "./types";
import { eq } from "drizzle-orm";
import { GetDb } from "../../db";
import { inventory } from "../../db/schema";

import { logger } from "../../logger";
import { DoesCharacterBelongToUserId } from "../../controllers/character";
import { WalletBalance } from "../wallet/wallet";
import { CanonicaliseCurrency } from "../wallet/currency";

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
