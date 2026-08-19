import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";

// Import routes
import userRoutes from "@users/user.routes";
import authRoutes from "@auth/auth.routes";
import workspaceRoutes from "@rbac/workspace.routes";
import profileRoutes from "@rbac/profile.routes";
import pdfRoutes from "@pdf/pdf.routes";
import notificationRoutes from "@notifications/notification.routes";
import pincodeRoutes from "@reference-data/pincode.routes";
import masterDataRoutes from "@reference-data/masterData.routes";
import operatorRoutes from "@reference-data/operator.routes";
import importRoutes from "@import-export/import.routes";
import exportRoutes from "@import-export/export.routes";
import importExportLogRoutes from "@import-export/importExportLog.routes";
import workflowTemplateRoutes from "@workflow/workflowTemplate.routes";
import workflowRoutes from "@workflow/workflow.routes";
import "@mail/mail.queue"; // boots the BullMQ worker
import commentRoutes from "@comments/comments.routes";
import vendorOnboardRoutes from "@vendor-onboarding/vendorOnboarding.routes";
import leadRoutes from "@leads/leads.routes";
import reportRoutes from "@map/report.routes";
import epcRoutes from "@map/epc.routes";
import efpRoutes from "@map/epf.routes";
import crfRoutes from "@map/crf.routes";
import guestRoutes from "@guest/guest.routes";
import machineStudyRoutes from "@map/machineStudy.routes";
import errorHandler from "@shared/middleware/error.middleware";
import ApiError from "@shared/utils/apiError";
import { startJobs } from "@shared/jobs/scheduler";

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
app.use("/api/v1/notifications", notificationRoutes);
app.use("/api/v1/vendor-onboarding", vendorOnboardRoutes);
app.use("/api/v1/pdf", pdfRoutes);
app.use("/api/v1/guest", guestRoutes);
app.use("/api/v1/machine-studies", machineStudyRoutes);

// Scheduler
startJobs();

/* 404 */
app.use((req, res, next) => {
  next(new ApiError(404, `Route not found: ${req.originalUrl}`));
});

/* Global error handler */
app.use(errorHandler);

export default app;
