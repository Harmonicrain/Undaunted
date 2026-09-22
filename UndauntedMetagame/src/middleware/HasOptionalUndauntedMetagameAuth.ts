import { NextFunction, Request, Response } from "express";
import { ValidateMetagameJWTAndGetPayload } from "../controllers/auth";

// Same token handling as HasUndauntedMetagameAuth, but a missing or unusable
// token is not fatal: the request continues with no AuthData. For routes the
// runtime calls without ever attaching credentials, where refusing the request
// outright is worse than answering it anonymously.
export async function HasOptionalUndauntedMetagameAuth(req: Request, res: Response, next: NextFunction){
    const AuthHeader = req.headers.authorization;

    if(AuthHeader != undefined && AuthHeader.toLowerCase().startsWith("bearer ")){
        try{
            (req as any).AuthData = ValidateMetagameJWTAndGetPayload(AuthHeader.slice("bearer ".length));
        } catch {
            // Deliberately unauthenticated - the route decides what it can still answer.
        }
    }

    next();
}
