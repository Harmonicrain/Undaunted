/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Further modified in September 2026 for the Undaunted 1.4.4 preservation fork
 * (Harmonicrain/Undaunted): adapted to the 1.4.4 client, SQLite persistence and
 * a raw TCP XMPP listener. Not an official release of either upstream project.
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */
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
