import { Router } from "express";
import multer from "multer";
import asyncHandler from "@shared/middleware/async.middleware";
import { requireAuth } from "@auth/auth.middleware";
import {
  createMachineStudy,
  updateMachineStudy,
  getMachineStudiesForEpc,
  getMachineStudyById,
  uploadMachineStudyCycles,
} from "./machineStudy.controller";

const uploadCycleFile = multer({ storage: multer.memoryStorage() }).single(
  "file",
);

const router = Router();

router.get("/epc/:epcId", requireAuth, asyncHandler(getMachineStudiesForEpc));
router.get("/:id", requireAuth, asyncHandler(getMachineStudyById));
router.post("/", requireAuth, asyncHandler(createMachineStudy));
router.patch("/:id", requireAuth, asyncHandler(updateMachineStudy));
router.post(
  "/:id/cycles",
  requireAuth,
  uploadCycleFile,
  asyncHandler(uploadMachineStudyCycles),
);

export default router;
