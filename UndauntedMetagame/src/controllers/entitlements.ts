import { and, eq } from "drizzle-orm";
import { GetDb } from "../db";
import { entitlements } from "../db/schema";
import { logger } from "../logger";

// Entitlements are the client's gate for premium content - the Hunt Pass Elite
// track checks for one. GET /entitlementsv2 previously returned an empty list
// unconditionally, so nothing could ever be unlocked.
//
// 1.4.4's QueryEntitlements entry serializer at VA 0x140b12e40 reads
// name / duration / activatedDate. The nearby "entitlement" string belongs
// to a different DTO; string proximity does not establish a wire contract.

function ToWireEntitlement(Row: typeof entitlements.$inferSelect){
    return {
        name: Row.entitlement,
        duration: Row.duration,
        activatedDate: new Date(Row.activatedAt).toISOString()
    };
}

export async function GetEntitlementsForUser(UserId: string){
    const Rows = await GetDb().select().from(entitlements)
        .where(eq(entitlements.userId, UserId));

    return Rows.map(ToWireEntitlement);
}

export async function HasEntitlement(UserId: string, Entitlement: string){
    const Row = await GetDb().select().from(entitlements)
        .where(and(eq(entitlements.userId, UserId), eq(entitlements.entitlement, Entitlement)))
        .limit(1);

    return Row.length > 0;
}

// Administrative grant, for an operator handing out access without a purchase.
// The store's redeem path writes its own row inside its transaction instead, so
// the grant and the receipt commit together.
export async function GrantEntitlement(UserId: string, Entitlement: string, Source = "admin", Duration = 0){
    if(await HasEntitlement(UserId, Entitlement)){
        return false;
    }

    await GetDb().insert(entitlements).values({
        userId: UserId,
        entitlement: Entitlement,
        duration: Duration,
        activatedAt: Date.now(),
        source: Source
    });

    logger.info(`Granted entitlement ${Entitlement} to ${UserId} (${Source})`);

    return true;
}

export async function RevokeEntitlement(UserId: string, Entitlement: string){
    await GetDb().delete(entitlements)
        .where(and(eq(entitlements.userId, UserId), eq(entitlements.entitlement, Entitlement)));

    logger.info(`Revoked entitlement ${Entitlement} from ${UserId}`);
}
