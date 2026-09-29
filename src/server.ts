import dotenv from "dotenv";
import app from "./app";
import logger from "@shared/utils/logger";
import { startSseSubscriber } from "@notifications/sse.subscriber";

dotenv.config();
const PORT = process.env.PORT || 9000;

// Bridges Redis pub/sub announcements to this process's local SSE
// connections. Must run in the API process, not the worker process —
// see realtime/sse.bootstrap.ts for why.
startSseSubscriber();

const server = app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});

// Graceful shutdown: on pm2 restart/delete (or Ctrl+C), stop accepting new
// connections and let in-flight requests finish before exiting. Without
// this, pm2 on Windows can mark the process as stopped while the
// underlying node.exe stays alive and keeps holding the port.
function shutdown(signal: string) {
  logger.info(`${signal} received — closing server`);
  server.close(() => {
    logger.info("Server closed. Exiting.");
    process.exit(0);
  });

  // Safety net: if something (e.g. a leaked SSE/keep-alive connection)
  // prevents server.close() from ever calling back, force exit instead
  // of hanging forever as an orphaned process.
  setTimeout(() => {
    logger.warn("Forced shutdown after timeout");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
