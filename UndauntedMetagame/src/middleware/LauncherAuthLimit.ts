import { Request, Response, NextFunction } from "express";

const Buckets = new Map<string, { attempts: number; until: number }>();
// Use the socket address: untrusted forwarded headers cannot bypass throttling.
export function LauncherAuthLimit(req: Request, res: Response, next: NextFunction) {
    const Now = Date.now();
    for (const [Key, Bucket] of Buckets) if (Bucket.until <= Now) Buckets.delete(Key);
    const Key = req.ip ?? req.socket.remoteAddress ?? "unknown";
    let Bucket = Buckets.get(Key);
    if (!Bucket) {
        if (Buckets.size >= 10000) { res.status(503).json({ message: "Please try again shortly." }); return; }
        Bucket = { attempts: 0, until: Now + 10 * 60 * 1000 }; Buckets.set(Key, Bucket);
    }
    Bucket.attempts++;
    if (Bucket.attempts > 30) {
        res.set("Retry-After", String(Math.ceil((Bucket.until - Now) / 1000)));
        res.status(429).json({ message: "Too many attempts. Try again in a few minutes." }); return;
    }
    next();
}
