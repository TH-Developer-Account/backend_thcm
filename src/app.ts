import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import userRoutes from "./routes/user.routes";
import authRoutes from "./routes/auth.routes";
import epcRoutes from "./routes/epc.routes";
import errorHandler from "./middleware/error.middleware";
import ApiError from "./utils/apiError";
import { startJobs } from "./jobs/scheduler";

const corsOptions = {
  origin: process.env.FRONTEND_URL, // frontend URL
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true, // allow cookies / auth headers
};

const app = express();

//Middlewares
app.use(cors(corsOptions));
app.use(cookieParser());
app.use(express.json());

app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/users", userRoutes);
app.use("/api/v1/epc", epcRoutes);

// Scheduler
startJobs();

/* 404 */
app.use((req, res, next) => {
  next(new ApiError(404, `Route not found: ${req.originalUrl}`));
});

/* Global error handler */
app.use(errorHandler);

export default app;
