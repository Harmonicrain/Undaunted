import { app } from "./app";
import { DrainAndRegisterAPIKeys } from "./controllers/apikeys";
import { DrainAndRegisterUserAPIKeys } from "./controllers/auth";
import { GetDb } from "./db";
import { logger } from "./logger";
import { initRealtime } from "./realtime";

const PORT = process.env.PORT;
const HOST = process.env.HOST || "127.0.0.1";

GetDb(); // This runs migrations TODO make this more explicit

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
