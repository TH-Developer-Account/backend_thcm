import { Router } from "express";
import asyncHandler from "../middleware/async.middleware";
import { getMasterData } from "../controllers/masterData.controller";

const router = Router();

router.get("/", asyncHandler(getMasterData));

export default router;
