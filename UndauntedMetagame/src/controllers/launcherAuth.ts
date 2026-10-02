import { argon2, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { GetDb } from "../db";
import { REGISTRATION_MODE } from "./undauntedapi";

const ACCESS_MS = 15 * 60 * 1000;
const REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
const EXCHANGE_MS = 60 * 1000;
const PARAMETERS = { parallelism: 1, tagLength: 32, memory: 19456, passes: 2 };
let ActiveHashes = 0;

export class LauncherError extends Error {
    constructor(public status: number, message: string) { super(message); }
}
type Account = { userId: string; name: string; passwordHash: string };
type Session = { sessionId: string; userId: string; name: string };
const Client = () => GetDb().$client;
export const TokenHash = (Value: string) => createHash("sha256").update(Value).digest("hex");
const Token = (Prefix: string) => Prefix + randomBytes(32).toString("hex");

function Username(Value: unknown): string {
    if (typeof Value !== "string" || !/^[A-Za-z0-9_-]{3,16}$/.test(Value.trim())) {
        throw new LauncherError(400, "Use a username of 3–16 letters, numbers, underscores or hyphens.");
    }
    return Value.trim();
}
function Password(Value: unknown): string {
    if (typeof Value !== "string" || Value.length < 12 || Value.length > 128) {
        throw new LauncherError(400, "Use a password of 12–128 characters.");
    }
    return Value;
}
function Derive(Password: string, Salt: Buffer): Promise<Buffer> {
    if (ActiveHashes >= 4) throw new LauncherError(503, "Please try again shortly.");
    ActiveHashes++;
    return new Promise((Resolve, Reject) => {
        try {
            argon2("argon2id", { ...PARAMETERS, message: Password, nonce: Salt }, (Error, Hash) => {
                ActiveHashes--;
                if (Error) Reject(Error); else Resolve(Hash);
            });
        } catch (Error) { ActiveHashes--; Reject(Error); }
    });
}
async function HashPassword(Value: string): Promise<string> {
    const Salt = randomBytes(16);
    const Hash = await Derive(Value, Salt);
    return `$argon2id$v=19$m=19456,t=2,p=1$${Salt.toString("base64")}$${Hash.toString("base64")}`;
}
async function VerifyPassword(Value: string, Stored: string | undefined): Promise<boolean> {
    // Missing accounts pay the same hashing cost; never skip the expensive work.
    const Parts = Stored?.split("$");
    const Valid = Parts?.length === 6 && Parts[1] === "argon2id" && Parts[2] === "v=19"
        && Parts[3] === "m=19456,t=2,p=1";
    const Salt = Valid ? Buffer.from(Parts![4], "base64") : Buffer.alloc(16);
    const Expected = Valid ? Buffer.from(Parts![5], "base64") : Buffer.alloc(32);
    const Hash = await Derive(Value, Salt);
    return !!Valid && Expected.length === Hash.length && timingSafeEqual(Expected, Hash);
}
function Prune() {
    const Db = Client();
    Db.prepare("DELETE FROM launcherexchanges WHERE expiresAt <= ?").run(Date.now());
    Db.prepare("DELETE FROM launchersessions WHERE refreshExpiresAt <= ?").run(Date.now());
}
function NewSession(UserId: string, Name: string) {
    Prune();
    const Access = Token("ULA_");
    const Refresh = Token("ULR_");
    const SessionId = randomUUID();
    Client().prepare(`INSERT INTO launchersessions
        (sessionId,userId,accessHash,accessExpiresAt,refreshHash,refreshExpiresAt)
        VALUES (?,?,?,?,?,?)`).run(SessionId, UserId, TokenHash(Access), Date.now() + ACCESS_MS,
            TokenHash(Refresh), Date.now() + REFRESH_MS);
    return { user: { userId: UserId, username: Name }, accessToken: Access,
        refreshToken: Refresh, expiresIn: ACCESS_MS / 1000 };
}
export async function RegisterLauncherAccount(Name: unknown, Secret: unknown, Invite: unknown) {
    const NameValue = Username(Name);
    const PasswordValue = Password(Secret);
    if (REGISTRATION_MODE !== "OPEN" && REGISTRATION_MODE !== "INVITECODE") {
        throw new LauncherError(403, "Registration is currently closed.");
    }
    const PasswordHash = await HashPassword(PasswordValue);
    const Db = Client();
    return Db.transaction(() => {
        if (Db.prepare("SELECT 1 FROM users WHERE lower(name) = lower(?)").get(NameValue)) {
            throw new LauncherError(409, "That username is already taken.");
        }
        if (REGISTRATION_MODE === "INVITECODE") {
            if (typeof Invite !== "string" || Invite.length > 128) {
                throw new LauncherError(403, "Enter a valid invitation code.");
            }
            const Result = Db.prepare(`UPDATE invitecodes SET usesRemaining =
                CASE WHEN infiniteUses THEN usesRemaining ELSE usesRemaining - 1 END
                WHERE inviteCode = ? AND (infiniteUses = 1 OR usesRemaining > 0)`).run(Invite.trim());
            if (Result.changes !== 1) throw new LauncherError(403, "Enter a valid invitation code.");
        }
        const UserId = `UID-${randomUUID()}`;
        Db.prepare("INSERT INTO users (userId,name,notes,isAdmin) VALUES (?,?,0,0)").run(UserId, NameValue);
        Db.prepare("INSERT INTO launchercredentials (userId,usernameNormalized,passwordHash) VALUES (?,?,?)")
            .run(UserId, NameValue.toLowerCase(), PasswordHash);
        return NewSession(UserId, NameValue);
    })();
}
export async function LoginLauncherAccount(Name: unknown, Secret: unknown) {
    if (typeof Name !== "string" || Name.length > 128 || typeof Secret !== "string" || Secret.length > 128) {
        throw new LauncherError(401, "Username or password is incorrect.");
    }
    const Account = Client().prepare(`SELECT c.userId,u.name,c.passwordHash FROM launchercredentials c
        JOIN users u ON u.userId=c.userId WHERE c.usernameNormalized=?`).get(Name.trim().toLowerCase()) as Account | undefined;
    if (!await VerifyPassword(Secret, Account?.passwordHash) || !Account) {
        throw new LauncherError(401, "Username or password is incorrect.");
    }
    return NewSession(Account.userId, Account.name);
}
export async function ClaimLauncherAccount(Key: unknown, Secret: unknown) {
    const PasswordValue = Password(Secret);
    if (typeof Key !== "string" || !/^UUK_[0-9a-f]{48}$/.test(Key)) {
        throw new LauncherError(401, "Account key is invalid or this account already has a password.");
    }
    const PasswordHash = await HashPassword(PasswordValue);
    const Db = Client();
    return Db.transaction(() => {
        const Account = Db.prepare(`SELECT u.userId,u.name FROM userapikeys k
            JOIN users u ON u.userId=k.userId WHERE k.keyHash=?`).get(TokenHash(Key)) as Account | undefined;
        if (!Account || Db.prepare("SELECT 1 FROM launchercredentials WHERE userId=?").get(Account.userId)) {
            throw new LauncherError(401, "Account key is invalid or this account already has a password.");
        }
        const Name = Username(Account.name);
        const Duplicates = Db.prepare("SELECT count(*) AS count FROM users WHERE lower(name)=lower(?)").get(Name) as { count: number };
        if (Duplicates.count !== 1) throw new LauncherError(409, "Ask the server owner to resolve your duplicate username first.");
        Db.prepare("INSERT INTO launchercredentials (userId,usernameNormalized,passwordHash) VALUES (?,?,?)")
            .run(Account.userId, Name.toLowerCase(), PasswordHash);
        // Preserve the key for existing scripts, but it can never set another password.
        return NewSession(Account.userId, Name);
    })();
}
export function RequireLauncherSession(Value: unknown): Session {
    if (typeof Value !== "string" || !/^ULA_[0-9a-f]{64}$/.test(Value)) throw new LauncherError(401, "Please sign in again.");
    const Session = Client().prepare(`SELECT s.sessionId,s.userId,u.name FROM launchersessions s
        JOIN users u ON u.userId=s.userId WHERE s.accessHash=? AND s.accessExpiresAt>? AND s.refreshExpiresAt>?`)
        .get(TokenHash(Value), Date.now(), Date.now()) as Session | undefined;
    if (!Session) throw new LauncherError(401, "Please sign in again.");
    return Session;
}
export function RefreshLauncherSession(Value: unknown) {
    if (typeof Value !== "string" || !/^ULR_[0-9a-f]{64}$/.test(Value)) throw new LauncherError(401, "Please sign in again.");
    const Db = Client();
    return Db.transaction(() => {
        const Old = Db.prepare(`SELECT s.sessionId,s.userId,u.name FROM launchersessions s
            JOIN users u ON u.userId=s.userId WHERE refreshHash=? AND refreshExpiresAt>?`)
            .get(TokenHash(Value), Date.now()) as Session | undefined;
        if (!Old) throw new LauncherError(401, "Please sign in again.");
        Db.prepare("DELETE FROM launcherexchanges WHERE sessionId=?").run(Old.sessionId);
        Db.prepare("DELETE FROM launchersessions WHERE sessionId=?").run(Old.sessionId);
        return NewSession(Old.userId, Old.name);
    })();
}
export function LogoutLauncherSession(Value: unknown) {
    if (typeof Value !== "string" || !/^ULR_[0-9a-f]{64}$/.test(Value)) return;
    const Db = Client();
    Db.transaction(() => {
        const Old = Db.prepare("SELECT sessionId FROM launchersessions WHERE refreshHash=?").get(TokenHash(Value)) as Session | undefined;
        if (Old) {
            Db.prepare("DELETE FROM launcherexchanges WHERE sessionId=?").run(Old.sessionId);
            Db.prepare("DELETE FROM launchersessions WHERE sessionId=?").run(Old.sessionId);
        }
    })();
}
export function IssueLauncherExchange(Access: unknown) {
    const Session = RequireLauncherSession(Access);
    const Code = Token("ULX_");
    const Db = Client();
    Db.transaction(() => {
        Prune();
        Db.prepare("DELETE FROM launcherexchanges WHERE sessionId=?").run(Session.sessionId);
        Db.prepare("INSERT INTO launcherexchanges (codeHash,userId,sessionId,expiresAt) VALUES (?,?,?,?)")
            .run(TokenHash(Code), Session.userId, Session.sessionId, Date.now() + EXCHANGE_MS);
    })();
    return { exchangeCode: Code, expiresIn: EXCHANGE_MS / 1000,
        user: { userId: Session.userId, username: Session.name } };
}
export function ConsumeLauncherExchange(Value: unknown): string | undefined {
    if (typeof Value !== "string" || !/^ULX_[0-9a-f]{64}$/.test(Value)) return undefined;
    const Row = Client().prepare(`DELETE FROM launcherexchanges WHERE codeHash=? AND expiresAt>?
        AND sessionId IN (SELECT sessionId FROM launchersessions WHERE refreshExpiresAt>?) RETURNING userId`)
        .get(TokenHash(Value), Date.now(), Date.now()) as { userId: string } | undefined;
    return Row?.userId;
}
