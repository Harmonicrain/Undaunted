import { NextFunction, Request, Response } from "express";
import { logger } from "../logger";

// Observation instrumentation. Several routes are stubs or deliberate failures,
// so nobody has ever seen what the client actually sends them or how it reacts
// to a response. This records those exchanges without changing any behaviour:
// every handler still runs exactly as before and returns exactly what it did.
//
// Enable with WIRE_CAPTURE=true. Off by default.

const CAPTURE_ENABLED = process.env.WIRE_CAPTURE === "true";

// Bodies are truncated and secrets removed before anything is written.
const MAX_BODY_CHARS = Number(process.env.WIRE_CAPTURE_MAX_BODY ?? 2000);

// A looping caller can otherwise produce megabytes of log in minutes - the
// loadout unlock loop managed 4.5 MB in ten. Cap captures per path per run.
const MAX_PER_PATH = Number(process.env.WIRE_CAPTURE_MAX_PER_PATH ?? 25);

const CAPTURED_PATHS: RegExp[] = [
    /^\/progression(\/|$)/,
    /^\/huntpass(\/|$)/,
    /^\/entitlement/,           // entitlementsv2, entitlementv2, entitlement
    /^\/product(\/|$)/,
    /^\/token(\/|$)/,
    /^\/notification(\/|$)/,
    /^\/balance(\/|$)/,
    /^\/reconcile(\/|$)/,
    /^\/party(\/|$)/,
    /^\/friends(\/|$)/,
    /^\/account\/api\/public\/account(\/|$)/,
    /^\/account\/mapping$/,
    /^\/accountinfo(\/|$)/,
    /^\/guild(\/|$)/,
    /^\/slayerlink(\/|$)/,
    /^\/present(\/|$)/,
    /^\/candidate(\/|$)/,
    /^\/loadout(\/|$)/,
    // Bounties are the Hunt Pass XP source, and POST /bounty/{acct} is the
    // client writing progress and claims back. Currently a stub that accepts
    // and discards, so its payload has never been recorded.
    /^\/bounty(\/|$)/,
    // The bounty system stores its token-grant marker in a cooldown, so these
    // decide whether a stored board survives a login.
    /^\/cooldown(\/|$)/,
    // Escalation season snapshots: GetSeasonalEscalationEndpoint and
    // UpdateSeasonalEscalationEndpoint (POST of the whole season state).
    /^\/escalation(\/|$)/,
];

const SECRET_KEY = /(auth|token|password|secret|key|uuk|apikey)/i;
const SECRET_VALUE = /UUK_[0-9a-f]+/gi;

const CaptureCounts: Map<string, number> = new Map<string, number>();

function Redact(Value: unknown, Depth = 0): unknown {
    if(Depth > 6){
        return "<depth-limit>";
    }

    if(typeof Value === "string"){
        return Value.replace(SECRET_VALUE, "<redacted-uuk>");
    }

    if(Array.isArray(Value)){
        return Value.slice(0, 40).map((Entry) => Redact(Entry, Depth + 1));
    }

    if(Value != null && typeof Value === "object"){
        const Out: Record<string, unknown> = {};

        for(const [Key, Inner] of Object.entries(Value as Record<string, unknown>)){
            Out[Key] = SECRET_KEY.test(Key) ? "<redacted>" : Redact(Inner, Depth + 1);
        }

        return Out;
    }

    return Value;
}

function Describe(Value: unknown){
    let Serialised: string;

    try{
        Serialised = JSON.stringify(Redact(Value));
    } catch {
        return "<unserialisable>";
    }

    if(Serialised == undefined){
        return "<empty>";
    }

    return Serialised.length > MAX_BODY_CHARS
        ? Serialised.slice(0, MAX_BODY_CHARS) + `…<truncated ${Serialised.length} chars>`
        : Serialised;
}

export function WireCapture(req: Request, res: Response, next: NextFunction){
    if(!CAPTURE_ENABLED || !CAPTURED_PATHS.some((Pattern) => Pattern.test(req.path))){
        next();
        return;
    }

    const CountKey = `${req.method} ${req.route?.path ?? req.path}`;
    const SeenSoFar = CaptureCounts.get(CountKey) ?? 0;

    if(SeenSoFar >= MAX_PER_PATH){
        next();
        return;
    }

    CaptureCounts.set(CountKey, SeenSoFar + 1);

    const StartedAt = Date.now();

    // Authority matters as much as the payload: the same path is called by both
    // the player's client and the gameserver, and they are not interchangeable.
    const Caller = req.headers["x-undaunted-gameserver-apikey"] != undefined
        ? "gameserver"
        : (req.headers.authorization != undefined ? "player" : "anonymous");

    res.on("finish", () => {
        logger.info({
            wire: {
                method: req.method,
                path: req.path,
                query: Object.keys(req.query).length > 0 ? Describe(req.query) : undefined,
                caller: Caller,
                // Gameserver context headers added by the runtime (request id,
                // world, co-present character ids). None of them is a secret.
                context: Caller === "gameserver" ? {
                    requestId: req.headers["x-undaunted-request-id"],
                    world: req.headers["x-undaunted-world"],
                    copresent: req.headers["x-undaunted-copresent"]
                } : undefined,
                body: req.body != undefined && Object.keys(req.body).length > 0 ? Describe(req.body) : undefined,
                status: res.statusCode,
                ms: Date.now() - StartedAt,
                seq: SeenSoFar + 1
            }
        }, `WIRE ${req.method} ${req.path} -> ${res.statusCode}`);
    });

    next();
}
