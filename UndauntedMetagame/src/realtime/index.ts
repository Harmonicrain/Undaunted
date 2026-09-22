import type { Server } from "node:http";
import { RealtimeGateway } from "./RealtimeGateway";
import { RawXMPPGateway } from "./RawXMPPGateway";
import { DEFAULT_LIMITS } from "./types";

export function initRealtime(server: Server){
    const gateway = new RealtimeGateway({ enabled: true, wsPaths: ["/", "//", "/__ws/xmpp"], allowedHosts: [], captureEnabled: true, limits: DEFAULT_LIMITS });
    gateway.attach(server);
    const rawGateway = new RawXMPPGateway();
    rawGateway.listen(Number(process.env.XMPP_PORT || 60002), process.env.HOST || "127.0.0.1");
    return { gateway, rawGateway };
}
