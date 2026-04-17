import { Router } from "express";
import asyncHandler from "../middleware/async.middleware";
import {
  getMasterData,
  manageMasterData,
} from "../controllers/masterData.controller";

const router = Router();

router.get("/", asyncHandler(getMasterData));
router.post("/manage", asyncHandler(manageMasterData));

export default router;
