import { Router } from "express";
import asyncHandler from "@shared/middleware/async.middleware";
import { requireAuth } from "@auth/auth.middleware";
import { getPdfUrl } from "./pdf.controller";

const router = Router();

router.get("/:type/:id/url", requireAuth, asyncHandler(getPdfUrl));

export default router;
