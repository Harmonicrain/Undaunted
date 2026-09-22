import { app } from "./app";
import { Startup } from "./controllers/gameservers";
import { RunWatchdog } from "./controllers/watchdog";
import { logger } from "./logger";

const PORT = process.env.PORT;
const HOST = process.env.HOST || "127.0.0.1";

app.listen(Number(PORT), HOST, () => {
  Startup().catch(error => logger.error({ error: error instanceof Error ? { message: error.message, stack: error.stack } : error }, "Initial world server startup failed"));

  if (process.env.ENABLE_WATCHDOG === "true") {
    setInterval(RunWatchdog, 60 * 1000);
  }

  logger.info(`Undaunted DeployServer on ${HOST}:${PORT}`);
  logger.info(`Clear Skies, Slayer.`);
});
