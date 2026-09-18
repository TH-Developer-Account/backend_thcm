import { Router } from "express";
import asyncHandler from "@shared/middleware/async.middleware";
import {
  getMasterData,
  manageMasterData,
  getProductsByType,
  getBudgetOData,
} from "./masterData.controller";

const router = Router();

router.get("/", asyncHandler(getMasterData));
router.get("/products", asyncHandler(getProductsByType));
router.post("/manage", asyncHandler(manageMasterData));
router.get("/budget", asyncHandler(getBudgetOData));

export default router;
