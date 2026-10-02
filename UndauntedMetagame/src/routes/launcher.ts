import { Router, Request, Response, ErrorRequestHandler } from "express";
import { ClaimLauncherAccount, IssueLauncherExchange, LauncherError, LoginLauncherAccount,
    LogoutLauncherSession, RefreshLauncherSession, RegisterLauncherAccount, RequireLauncherSession } from "../controllers/launcherAuth";
import { REGISTRATION_MODE } from "../controllers/undauntedapi";
import { logger } from "../logger";
import { LauncherAuthLimit as AuthLimit } from "../middleware/LauncherAuthLimit";

export const launcherRouter = Router();
const Access = (req: Request) => req.headers.authorization?.replace(/^Bearer /i, "");
function Handle(Action: (req: Request) => unknown | Promise<unknown>) {
    return async (req: Request, res: Response) => {
        try { res.json(await Action(req)); }
        catch (Error) {
            if (Error instanceof LauncherError) res.status(Error.status).json({ message: Error.message });
            else {
                // Never log bodies, credentials, tokens or error objects from authentication.
                logger.error("Launcher request failed");
                res.status(500).json({ message: "The server could not complete this request." });
            }
        }
    };
}
launcherRouter.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
launcherRouter.use((_req, res, next) => {
    if (process.env.AUTH_MODE !== "APIKEY") {
        res.status(503).json({ message: "The server owner must enable APIKEY authentication for the launcher." }); return;
    }
    next();
});
launcherRouter.get("/status", (_req, res) => res.json({ version: 1, gameVersion: "1.12.0", registrationMode: REGISTRATION_MODE }));
launcherRouter.post("/register", AuthLimit, Handle(req => RegisterLauncherAccount(req.body?.username, req.body?.password, req.body?.inviteCode)));
launcherRouter.post("/login", AuthLimit, Handle(req => LoginLauncherAccount(req.body?.username, req.body?.password)));
launcherRouter.post("/claim", AuthLimit, Handle(req => ClaimLauncherAccount(req.body?.accountKey, req.body?.password)));
launcherRouter.post("/refresh", Handle(req => RefreshLauncherSession(req.body?.refreshToken)));
launcherRouter.post("/logout", Handle(req => { LogoutLauncherSession(req.body?.refreshToken); return { ok: true }; }));
launcherRouter.get("/me", Handle(req => { const Session = RequireLauncherSession(Access(req)); return { userId: Session.userId, username: Session.name }; }));
launcherRouter.post("/exchange", Handle(req => IssueLauncherExchange(Access(req))));
// Body parser errors can include submitted text. Return a fixed message and do not log them.
export const LauncherBodyError: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.status(400).json({ message: "Invalid launcher request. Submit a small JSON object." });
};
