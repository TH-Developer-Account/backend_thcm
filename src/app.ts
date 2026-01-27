import express from "express";
import userRoutes from "./routes/user.routes";
import authRoutes from "./routes/auth.routes";
import errorHandler from "./middleware/error.middleware";
import ApiError from "./utils/apiError";

const app = express();

app.use(express.json());

app.use("/api/users", userRoutes);
app.use("/api/auth", authRoutes);

/* 404 */
app.use((req, res, next) => {
  next(new ApiError(404, `Route not found: ${req.originalUrl}`));
});

/* Global error handler */
app.use(errorHandler);

export default app;
