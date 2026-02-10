import dotenv from "dotenv";
import app from "./app";
import logger from "./config/logger";
// import { verifyEmailConnection } from "./utils/sendEmail";

dotenv.config();
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  logger.info(`Server running on port ${PORT}`);
  // await verifyEmailConnection();
});
