import { app } from "./app";
import { DrainAndRegisterAPIKeys } from "./controllers/apikeys";
import { DrainAndRegisterUserAPIKeys } from "./controllers/auth";
import { InitializeDatabase } from "./db";
import { HttpListenerConfig } from "./config/environment";
import { logger } from "./logger";
import { initRealtime } from "./realtime";

const { host: HOST, port: PORT } = HttpListenerConfig();

InitializeDatabase();

DrainAndRegisterAPIKeys().then(async () => {
  await DrainAndRegisterUserAPIKeys();
  
  const server = app.listen(Number(PORT), HOST, () => {
    logger.info(`Undaunted Metagame on ${HOST}:${PORT}`);
    logger.info(`Clear Skies, Slayer.`);
  });
  server.on("clientError", (error: any, socket) => {
    const prefix = Buffer.isBuffer(error?.rawPacket)
      ? error.rawPacket.subarray(0, 64).toString("hex")
      : "";
    logger.warn({ code: error?.code, prefix }, "HTTP listener rejected a non-HTTP client");
    if (!socket.destroyed) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  initRealtime(server);
});
