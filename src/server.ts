import dotenv from "dotenv";
import app from "./app";
import logger from "./config/logger";

dotenv.config();
const PORT = process.env.PORT || 9000;

app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});
