// Native 1.12 cell exchanges use a stable identity for each of the three slots.
import { InventoryValidationError } from "../inventory/types";

export const FUSION_CATALOG_ID = "TOKEN_CELL_EXCHANGE";

export type FusionData = {
    SlotID: number;
    EndTime: string;
    ResultCell: string;
    ExchangeID: string;
};

export function ParseFusionData(Item: any): FusionData {
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

export function FusionInstanceId(SlotID: number){
    return `${FUSION_CATALOG_ID}:${SlotID}`;
}

export function NormaliseFusionItem(Item: any){
    if(Item?.catalogId !== FUSION_CATALOG_ID) return Item;
    const Data = ParseFusionData(Item);
    Item.instanceId = FusionInstanceId(Data.SlotID);
    return Item;
}

export function FindIncomingInstancedItemIndex(InstancedItems: any[], IncomingItem: any){
    const Exact = InstancedItems.findIndex((Item) => Item.instanceId === IncomingItem.instanceId);
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

export function IsValidFusionSave(CurrentItem: any, IncomingItem: any, Operation: string){
    if(Operation !== "save" && Operation !== "update") return false;
    if(CurrentItem?.catalogId !== FUSION_CATALOG_ID || IncomingItem?.catalogId !== FUSION_CATALOG_ID) return false;
    if(CurrentItem.updateVersion !== IncomingItem.updateVersion) return false;

    const Current = ParseFusionData(CurrentItem);
    const Incoming = ParseFusionData(IncomingItem);
    return Current.SlotID === Incoming.SlotID && Current.ExchangeID === Incoming.ExchangeID &&
        Current.ResultCell === Incoming.ResultCell && Date.parse(Incoming.EndTime) <= Date.parse(Current.EndTime);
}
