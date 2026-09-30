import { readFileSync } from "node:fs";

// Opt-in, build-specific catalogue. Keep this outside HUNT_PASS_SEASONS_DIR:
// that directory contains progression definitions, not selector metadata.
export type LibraryPass = {
    trackId: string;
    rowName: string;
    sku: string;
    storeTag: string;
    entitlement: string;
    title: string;
    description: string;
    hasFreeTrack: boolean;
};

// 1.12's HuntPassItemViewModel compares the end-date year to
// BountyComponent.InvalidYear (2099) to set bNeverExpire. 2085 still counts down.
export const PermanentHuntPassEnd = "2099-01-01T00:00:00+00:00";

export function HasFreeHuntPassRewards(Path: { free_rewards?: any[] }): boolean {
    return (Path.free_rewards ?? []).some(Reward =>
        ["stacked_items", "instanced_items", "ordered_instanced_items", "entitlements", "buffs"]
            .some(Key => (Reward[Key] ?? []).length > 0));
}

export function ParseHuntPassLibrary(Value: unknown): LibraryPass[] {
    if(!Array.isArray(Value)) throw new Error("Hunt pass library must be an array");
    const Tracks = new Set<string>(), Rows = new Set<string>(), Skus = new Set<string>();
    return Value.map((Entry) => {
        if(Entry == null || typeof Entry !== "object" ||
            !["trackId", "rowName", "sku", "storeTag", "entitlement", "title", "description"].every(Key => typeof Entry[Key] === "string" && Entry[Key].trim().length > 0) ||
            typeof Entry.hasFreeTrack !== "boolean" || /^Hunt Pass \d/i.test(Entry.title) ||
            !/^season\d+[a-c]?(_vault)?$/.test(Entry.trackId)){
            throw new Error("Invalid regular/vault hunt pass library entry");
        }
        if(Tracks.has(Entry.trackId) || Rows.has(Entry.rowName) || Skus.has(Entry.sku)){
            throw new Error(`Duplicate hunt pass library entry: ${Entry.trackId}`);
        }
        Tracks.add(Entry.trackId); Rows.add(Entry.rowName); Skus.add(Entry.sku);
        return { trackId: Entry.trackId, rowName: Entry.rowName, sku: Entry.sku,
            storeTag: Entry.storeTag, entitlement: Entry.entitlement, title: Entry.title,
            description: Entry.description, hasFreeTrack: Entry.hasFreeTrack };
    });
}

const File = process.env.HUNT_PASS_LIBRARY_FILE;
const ConfiguredLibrary: readonly LibraryPass[] = File
    ? ParseHuntPassLibrary(JSON.parse(readFileSync(File, "utf8"))) : [];
const ConfiguredIds = new Set(ConfiguredLibrary.map(Pass => Pass.trackId));
const DuplicateVaults = ConfiguredLibrary.filter(Pass => Pass.trackId.endsWith("_vault")
    && ConfiguredIds.has(Pass.trackId.slice(0, -6)));
const DuplicateVaultIds = new Set(DuplicateVaults.map(Pass => Pass.trackId));
export const HiddenVaultRows = DuplicateVaults.map(Pass => Pass.rowName);
export const HuntPassLibrary = ConfiguredLibrary.filter(Pass => !DuplicateVaultIds.has(Pass.trackId));
const Ids = new Set(HuntPassLibrary.map(Pass => Pass.trackId));
export const IsLibraryHuntPass = (Id: string) => Ids.has(Id);
// Premium-only archive passes have no free lane to progress. Make their sole
// lane available by policy without manufacturing permanent account purchases.
export const IsUnlockedPremiumOnlyPass = (Id: string) =>
    HuntPassLibrary.some(Pass => Pass.trackId === Id && !Pass.hasFreeTrack);
export const IsUnlockedPremiumOnlyOffer = (Sku: string) =>
    HuntPassLibrary.some(Pass => Pass.sku === Sku && !Pass.hasFreeTrack);

// Match the local main pass's free Elite offer. Unlocking is explicit through
// the existing purchase flow; simply listing/selecting a pass grants nothing.
export function AddHuntPassLibraryOffers(Catalog: Record<string, any>): Record<string, any> {
    if(HuntPassLibrary.length === 0) return Catalog;
    const Result = { ...Catalog };
    const RemovedSkus = new Set(DuplicateVaults.map(Pass => Pass.sku));
    const LibrarySkus = new Set(HuntPassLibrary.map(Pass => Pass.sku));
    const Offers = HuntPassLibrary.map((Pass, Index) => ({
        id: Pass.sku, displayName: Pass.hasFreeTrack ? `${Pass.title} — Elite Upgrade` : Pass.title,
        displayDescription: Pass.hasFreeTrack
            ? `${Pass.description}\n\nUnlocks the Elite reward track. Hunt Pass levels must still be earned. Available permanently.`
            : Pass.description,
        displayPriority: Index + 1, tags: [Pass.storeTag, "huntpass_store"],
        platinumPrice: 0, platinumSalePrice: null, cellDustPrice: null, prestigePrice: null,
        event01Price: null, steelMarksPrice: null, gildedMarksPrice: null,
        items: [], entitlements: [{ name: Pass.entitlement, duration: 0 }],
        maxAllowed: 1, remaining: 1, loadoutSlots: null, availableFrom: null,
        availableTo: null, timeAvailabilityReason: null, platformOfferId: null, missingEntitlementNames: null
    }));
    // Replace the same SKU consistently under every tag, including a main
    // pass offer which already existed before the library was enabled.
    const BySku = new Map(Offers.map(Offer => [Offer.id, Offer]));
    for(const [Tag, Values] of Object.entries(Result)){
        if(!Tag.startsWith("_") && Array.isArray(Values)) Result[Tag] = Values
            .filter(Offer => !RemovedSkus.has(Offer.id)).map(Offer => BySku.get(Offer.id) ?? Offer);
    }
    for(const [Index, Pass] of HuntPassLibrary.entries()){
        Result[Pass.storeTag] = [...(Result[Pass.storeTag] ?? []).filter((Offer: any) => !LibrarySkus.has(Offer.id)), Offers[Index]];
    }
    Result.huntpass_store = [...(Result.huntpass_store ?? []).filter((Offer: any) => !LibrarySkus.has(Offer.id)), ...Offers];
    return Result;
}
