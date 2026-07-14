import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";

// Import routes
import userRoutes from "./routes/user.routes";
import authRoutes from "./routes/auth.routes";
import epcRoutes from "./routes/epc.routes";
import workspaceRoutes from "./routes/workspace.routes";
import profileRoutes from "./routes/profile.routes";
import masterDataRoutes from "./routes/masterData.routes";
import workflowTemplateRoutes from "./routes/workflowTemplate.routes";
import workflowRoutes from "./routes/workflow.routes";
import efpRoutes from "./routes/epf.routes";
import crfRoutes from "./routes/crf.routes";
import commentRoutes from "./routes/comments.routes";
import operatorRoutes from "./routes/operator.routes";
import leadRoutes from "./routes/leads.routes";
import reportRoutes from "./routes/report.routes";
import importRoutes from "./routes/import.routes";
import exportRoutes from "./routes/export.routes";
import pincodeRoutes from "./routes/pincode.routes";
import importExportLogRoutes from "./routes/importExportLog.routes";
import vendorOnboardRoutes from "./routes/vendorOnboarding.routes";

import errorHandler from "./middleware/error.middleware";
import ApiError from "./utils/apiError";

import { startJobs } from "./jobs/scheduler";
import "./services/mail.queue"; // boots the BullMQ worker

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
app.use("/api/v1/workspaces", workspaceRoutes);
app.use("/api/v1/profile", profileRoutes);
app.use("/api/v1/master-data", masterDataRoutes);
app.use("/api/v1/work-flow", workflowTemplateRoutes);
app.use("/api/v1/soa", workflowRoutes);
app.use("/api/v1/epf", efpRoutes);
app.use("/api/v1/crf", crfRoutes);
app.use("/api/v1/comment", commentRoutes);
app.use("/api/v1/operator", operatorRoutes);
app.use("/api/v1/leads", leadRoutes);
app.use("/api/v1/pincodes", pincodeRoutes);
app.use("/api/v1/report", reportRoutes);
app.use("/api/v1/import", importRoutes);
app.use("/api/v1/export", exportRoutes);
app.use("/api/v1/import-export-logs", importExportLogRoutes);
app.use("/api/v1/vendor-onboard", vendorOnboardRoutes);

// Scheduler
startJobs();

/* 404 */
app.use((req, res, next) => {
  next(new ApiError(404, `Route not found: ${req.originalUrl}`));
});

/* Global error handler */
app.use(errorHandler);

export default app;
