import { inventory } from "../../db/schema";
import { InventoryValidationError, InventoryConflictError } from "./types";
import { IsValidFusionSave } from "../middleman/fusion";

export function MakeEmptyInventoryRow(CharacterId: string): typeof inventory.$inferInsert {
    return {
        characterId: CharacterId,
        instancedItems: "[]",
        stackedItems: "[]",
    };
}

export function HasStatelessItemData(Item: any){
    return !Object.prototype.hasOwnProperty.call(Item, "itemData") || Item.itemData == null;
}

export function IsAllowedStaleStatelessReplacement(CurrentItem: any, IncomingItem: any, Operation: string){
    return Operation !== "remove"
        && HasStatelessItemData(CurrentItem)
        && HasStatelessItemData(IncomingItem)
        && CurrentItem.updateVersion === 0;
}

// Stacked quantities arrived unvalidated: a non-numeric or negative quantity
// was applied verbatim, so a negative "add" silently removed items and a
// removal could drive a stack below zero.
export function AssertValidStackedQuantity(Item: any, Operation: string){
    const Quantity = Number(Item?.quantity);

    if(!Number.isInteger(Quantity) || Quantity <= 0){
        throw new InventoryValidationError(`Refusing stacked item ${Operation} ${Item?.catalogId}: quantity must be a positive integer, got ${JSON.stringify(Item?.quantity)}`);
    }

    return Quantity;
}

export function AssertValidIncomingInstancedItem(IncomingItem: any, Operation: string){
    if(HasStatelessItemData(IncomingItem) && IncomingItem.updateVersion !== 0){
        throw new InventoryValidationError(`Refusing stateless instanced item ${Operation} ${IncomingItem.catalogId}/${IncomingItem.instanceId}: expected updateVersion 0, got ${IncomingItem.updateVersion}`);
    }
}

export function AssertExistingInstancedItemWrite(CurrentItem: any, IncomingItem: any, Operation: string): "write" | "skip"{
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
