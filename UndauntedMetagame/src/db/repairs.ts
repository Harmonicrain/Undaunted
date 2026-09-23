// Data repairs that run after the schema migrations. Each one is narrow and
// idempotent: it only touches rows that are still invalid, so running it on
// every start is a no-op once the data is clean.

type Client = {
    prepare(Sql: string): { all(...Args: unknown[]): any[], run(...Args: unknown[]): unknown },
    transaction<T>(Fn: () => T): () => T
};

const VALID_SLOTS = [1, 2, 3];

// The backend originally allocated Slayer Link slots 0..2, but the 1.4.4
// client only understands 1..3, so a link stored with slot 0 is invisible to
// that player. Each invalid side moves to the lowest slot its account is not
// already using. The link id, dates, progress and the partner's side are left
// exactly as they were. A side with no free slot is left alone and reported:
// deleting it would destroy a link the player may have earned progress on.
export function RepairLegacySlayerLinkSlots(Db: Client, Log: (Message: string) => void = () => {}){
    const Repaired: { linkId: string, accountId: string, from: number, to: number }[] = [];

    Db.transaction(() => {
        const Links = Db.prepare(
            "SELECT * FROM slayerlinks WHERE senderSlot NOT IN (1, 2, 3) OR targetSlot NOT IN (1, 2, 3) ORDER BY createdAt, linkId").all();

        for(const Link of Links){
            for(const Side of ["sender", "target"] as const){
                const AccountId: string = Side === "sender" ? Link.senderId : Link.targetId;
                const Slot: number = Side === "sender" ? Link.senderSlot : Link.targetSlot;

                if(VALID_SLOTS.includes(Slot)){
                    continue;
                }

                // Re-read per side so an earlier repair in this loop is seen.
                const Used = new Set<number>(Db.prepare(`
                    SELECT senderSlot AS slot FROM slayerlinks
                        WHERE senderId = ? AND linkId <> ? AND canceledAt IS NULL AND senderReleasedAt IS NULL
                    UNION ALL
                    SELECT targetSlot AS slot FROM slayerlinks
                        WHERE targetId = ? AND linkId <> ? AND canceledAt IS NULL AND targetReleasedAt IS NULL`)
                    .all(AccountId, Link.linkId, AccountId, Link.linkId).map((Row: any) => Row.slot));

                const Free = VALID_SLOTS.find((Candidate) => !Used.has(Candidate));

                if(Free === undefined){
                    Log(`Slayer Link ${Link.linkId}: ${AccountId} has no free slot to replace invalid slot ${Slot}; left unchanged`);
                    continue;
                }

                Db.prepare(`UPDATE slayerlinks SET ${Side === "sender" ? "senderSlot" : "targetSlot"} = ? WHERE linkId = ?`)
                    .run(Free, Link.linkId);

                Repaired.push({ linkId: Link.linkId, accountId: AccountId, from: Slot, to: Free });
                Log(`Slayer Link ${Link.linkId}: moved ${AccountId} from invalid slot ${Slot} to slot ${Free}`);
            }
        }
    })();

    return Repaired;
}
