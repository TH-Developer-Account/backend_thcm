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

app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});
