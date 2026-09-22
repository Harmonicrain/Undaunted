import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { GetDb } from "../db";
import { characters, entitlements, progression, progressionclaims } from "../db/schema";
import { ApplyInventoryTransaction } from "./inventory";
import { CreditWallet, IsCurrency } from "./wallet";
import { DeriveRank, GetTrackConfig } from "./huntpass";
import { HasPremiumForTrack } from "./progressionTracks";
import { logger } from "../logger";

// Granting Hunt Pass rank rewards.
//
// Everything here runs inside one better-sqlite3 transaction and is therefore
// synchronous: the inventory change, the wallet credit, the entitlement insert
// and the claim ledger row all commit together or not at all. A partial grant
// is the failure mode that matters, because a player who received items but no
// ledger row is granted them again on the next call.

export type RewardKind = "free" | "premium";

export class RewardError extends Error {
    constructor(public status: number, message: string){ super(message); }
}

// The claim key, and the inventory transaction id derived from it.
//
// inventorytransactions.transactionId is a GLOBAL primary key and
// ApplyInventoryTransaction hashes the account and character into its request
// hash. An id that omitted them - "huntpass:<track>:<rank>:<kind>" - collides
// across accounts: the first player to claim a rank succeeds and every other
// player is rejected with a conflict. The full tuple is required.
export function ClaimKey(UserId: string, CharacterId: string, TrackId: string, Generation: number, RankId: number, Kind: RewardKind){
    return `huntpass:${UserId}:${CharacterId}:${TrackId}:${Generation}:${RankId}:${Kind}`;
}

// Config rewards are snake_case; the inventory and store layers are camelCase.
// Currencies are split out because they are account-scoped and a stacked item
// grant would never reach GET /balance.
export function ClassifyReward(Reward: any){
    const StackedFromConfig: any[] = Reward?.stacked_items ?? [];

    const StackedItems: { catalogId: string, quantity: number }[] = [];
    const Currencies: { currencyId: string, quantity: number }[] = [];

    for(const Entry of StackedFromConfig){
        if(typeof Entry?.catalog_id !== "string" || !Number.isSafeInteger(Entry?.quantity) || Entry.quantity < 0){
            throw new RewardError(500, `Malformed stacked reward ${JSON.stringify(Entry)}`);
        }

        // The shipped config really does contain zero-quantity entries
        // (MasteryTrack_PlayerLevel ranks 6, 8 and 10 list a Slayer core with
        // quantity 0). They grant nothing. Rejecting them failed the whole
        // claim, so PlayerLevel could never be confirmed past rank 5 and the
        // gameserver retried the confirmation on every login.
        if(Entry.quantity === 0){
            continue;
        }

        if(IsCurrency(Entry.catalog_id)){
            Currencies.push({ currencyId: Entry.catalog_id, quantity: Entry.quantity });
        }
        else{
            StackedItems.push({ catalogId: Entry.catalog_id, quantity: Entry.quantity });
        }
    }

    // instanced_items is an array of catalogue ids; ordered_instanced_items
    // carries the same thing with a display priority.
    const InstancedIds: string[] = [
        ...(Reward?.instanced_items ?? []),
        ...((Reward?.ordered_instanced_items ?? []).map((Entry: any) => Entry?.catalog_id ?? Entry))
    ].filter((Value: any) => typeof Value === "string");

    // The config spells these {entitlement, duration}; the store catalogue
    // spells the same thing {name, duration}. Accept either.
    const Entitlements = (Reward?.entitlements ?? []).map((Entry: any) => ({
        name: Entry?.entitlement ?? Entry?.name,
        duration: Entry?.duration ?? 0
    })).filter((Entry: any) => typeof Entry.name === "string" && Entry.name.length > 0);

    return { StackedItems, Currencies, InstancedIds, Entitlements };
}

// Instanced items need a stable identity per claim, so a retry addresses the
// same instance instead of minting a second one.
function InstanceIdFor(Key: string, CatalogId: string, Ordinal: number){
    return createHash("sha256").update(`${Key}:${CatalogId}:${Ordinal}`).digest("hex").slice(0, 32);
}

function RewardForRank(TrackId: string, RankId: number, Kind: RewardKind){
    const Track = GetTrackConfig(TrackId);

    const Table = Kind === "premium" ? Track?.premium_rewards : Track?.free_rewards;

    return (Table ?? []).find((Entry: any) => Entry?.rank_id === RankId);
}

// Grants one rank on one track, inside the caller's transaction.
//
// Returns false when the rank was already claimed, which is not an error: a
// retry after a lost response must be a no-op rather than a second payout.
function GrantRankInTransaction(tx: any, UserId: string, CharacterId: string, TrackId: string, Generation: number, RankId: number, Kind: RewardKind){
    const Already = tx.select().from(progressionclaims)
        .where(and(
            eq(progressionclaims.userId, UserId),
            eq(progressionclaims.trackId, TrackId),
            eq(progressionclaims.generation, Generation),
            eq(progressionclaims.rankId, RankId),
            eq(progressionclaims.kind, Kind))).get();

    if(Already != undefined){
        return false;
    }

    const Reward = RewardForRank(TrackId, RankId, Kind);

    const Key = ClaimKey(UserId, CharacterId, TrackId, Generation, RankId, Kind);

    // A rank with no configured reward still records a claim. Without the row
    // the rank would be re-examined on every read, and the absence of a reward
    // would be indistinguishable from a grant that failed.
    if(Reward != undefined){
        const { StackedItems, Currencies, InstancedIds, Entitlements } = ClassifyReward(Reward);

        const InstancedItems = InstancedIds.map((CatalogId, Ordinal) => ({
            catalogId: CatalogId,
            instanceId: InstanceIdFor(Key, CatalogId, Ordinal),
            itemData: null,
            updateVersion: 0
        }));

        if(StackedItems.length > 0 || InstancedItems.length > 0){
            ApplyInventoryTransaction(tx, UserId, CharacterId, Key, InstancedItems, StackedItems, [], [], []);
        }

        for(const Currency of Currencies){
            CreditWallet(tx, UserId, Currency.currencyId, Currency.quantity);
        }

        for(const Grant of Entitlements){
            const Held = tx.select().from(entitlements)
                .where(and(eq(entitlements.userId, UserId), eq(entitlements.entitlement, Grant.name))).get();

            if(Held == undefined){
                tx.insert(entitlements).values({
                    userId: UserId,
                    entitlement: Grant.name,
                    duration: Grant.duration,
                    activatedAt: Date.now(),
                    source: `huntpass:${TrackId}:${RankId}`
                }).run();
            }
        }
    }

    tx.insert(progressionclaims).values({
        userId: UserId, trackId: TrackId, generation: Generation,
        rankId: RankId, kind: Kind, characterId: CharacterId, claimedAt: Date.now()
    }).run();

    return true;
}

// Grants every unclaimed rank up to the rank the player has actually earned.
//
// Catch-up matters in two ordinary cases: a player who earns several ranks in
// one hunt, and a player who buys Elite after already reaching rank 20 and is
// owed twenty premium ranks retroactively.
export function ClaimRanksUpTo(UserId: string, CharacterId: string, TrackId: string, UpToRank: number, Kind: RewardKind, Transaction?: any){
    if(GetTrackConfig(TrackId) == undefined){
        throw new RewardError(404, `Unknown progression track ${TrackId}`);
    }

    const Granted: number[] = [];

    const Apply = (tx: any) => {
        // Ownership is re-checked inside the transaction, not only at request
        // entry: the character could have been deleted between the two.
        const Character = tx.select().from(characters)
            .where(eq(characters.characterId, CharacterId)).get();

        if(Character == undefined || Character.userId !== UserId){
            throw new RewardError(403, "Character does not belong to this account");
        }

        const State = tx.select().from(progression)
            .where(and(eq(progression.userId, UserId), eq(progression.trackId, TrackId))).get();

        const Generation = State?.generation ?? 0;

        // Premium eligibility is re-checked here too, so a revoked entitlement
        // cannot be raced into a payout.
        if(Kind === "premium" && !HasPremiumForTrack(UserId, TrackId)){
            throw new RewardError(403, `Account does not hold premium for ${TrackId}`);
        }

        const Earned = DeriveRank(TrackId, State?.totalPoints ?? 0).rank;
        if(!Number.isSafeInteger(UpToRank) || UpToRank < 0 || UpToRank > Earned){
            throw new RewardError(400, "Cannot claim an unearned rank");
        }

        for(let RankId = 0; RankId <= UpToRank; RankId++){
            if(GrantRankInTransaction(tx, UserId, CharacterId, TrackId, Generation, RankId, Kind)){
                Granted.push(RankId);
            }
        }
    };

    if(Transaction){
        Apply(Transaction);
    } else {
        GetDb().transaction(Apply, { behavior: "immediate" });
    }

    if(Granted.length > 0){
        logger.info(`Granted ${Kind} ranks [${Granted.join(", ")}] on ${TrackId} to ${UserId}`);
    }

    return Granted;
}

// The rank the player has earned, from stored points against the config.
export function EarnedRank(UserId: string, TrackId: string){
    const State = GetDb().select().from(progression)
        .where(and(eq(progression.userId, UserId), eq(progression.trackId, TrackId))).get();

    return DeriveRank(TrackId, State?.totalPoints ?? 0).rank;
}
