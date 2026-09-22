import { createServer, type Server } from "node:net";
import { logger } from "../logger";
import { RawXMPPConnection } from "./RawXMPPConnection";

export class RawXMPPGateway {
    private server?: Server;
    private connections = new Map<string, RawXMPPConnection>();

    listen(port: number, host: string){
        this.server = createServer(socket => {
            const connection = new RawXMPPConnection(socket, socket.remoteAddress ?? "unknown", closed => this.connections.delete(closed.connId));
            this.connections.set(connection.connId, connection);
        });
        this.server.on("error", error => logger.error(error, "[XMPP-TCP] listener failed"));
        this.server.listen(port, host, () => logger.info(`[XMPP-TCP] listening on ${host}:${port}`));
    }
}
