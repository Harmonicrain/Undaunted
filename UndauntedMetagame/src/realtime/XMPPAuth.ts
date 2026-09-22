/* Derived from Mystic-Paradox's AGPL-3.0 XMPP authentication work. */
import { ValidateMetagameJWTAndGetPayload } from "../controllers/auth";
import { GetDb } from "../db";
import { users } from "../db/schema";
import { eq } from "drizzle-orm";
import { parseSaslPlain } from "./saslPlain";

export type AuthOutcome = { ok: true, accountId: string } | { ok: false, reason: string };

export async function authenticateSasl(mechanism: string, saslB64: string): Promise<AuthOutcome> {
    const parsed = parseSaslPlain(mechanism, saslB64);
    if(!parsed.ok) return { ok: false, reason: parsed.reason };
    let payload: any;
    try { payload = ValidateMetagameJWTAndGetPayload(parsed.password); }
    catch { return { ok: false, reason: "jwt verify failed" }; }
    const accountId = payload?.userId;
    if(typeof accountId !== "string" || accountId !== parsed.authcid) return { ok: false, reason: "identity mismatch" };
    if(!GetDb().select().from(users).where(eq(users.userId, accountId)).get()) return { ok: false, reason: "unknown account" };
    return { ok: true, accountId };
}
