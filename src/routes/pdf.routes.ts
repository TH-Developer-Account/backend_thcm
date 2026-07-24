import { Router } from "express";
import asyncHandler from "../middleware/async.middleware";
import { requireAuth } from "../middleware/auth.middleware";
import { getPdfUrl } from "../controllers/pdf.controller";

const router = Router();

router.get("/:type/:id/url", requireAuth, asyncHandler(getPdfUrl));

export default router;
