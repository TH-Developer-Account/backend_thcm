import { Router } from "express";
import asyncHandler from "@shared/middleware/async.middleware";
import { firstAuthRequestPerDay } from "@shared/middleware/dailyActiveUsers.middleware";
import { requireAuth, authorize } from "../auth/auth.middleware";
import {
  getProfiles,
  getProfileById,
  createProfile,
  updateProfile,
  deleteProfile,
} from "./profile.controller";

const router = Router();

router.use(requireAuth); // sets req.user
router.use(firstAuthRequestPerDay); // tracks DAU

router.get("/", asyncHandler(getProfiles));
router.get("/:profileId", asyncHandler(getProfileById));
router.post("/create", asyncHandler(createProfile));
router.patch("/update/:profileId", asyncHandler(updateProfile));
router.delete("/delete/:profileId", asyncHandler(deleteProfile));

export default router;
