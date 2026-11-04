import { Router } from "express";

import asyncHandler from "@shared/middleware/async.middleware";
import { firstAuthRequestPerDay } from "@shared/middleware/dailyActiveUsers.middleware";

import { requireAuth, authorize } from "@auth/auth.middleware";
import {
  getCrfShopCatalog,
  getCrfShopProduct,
  checkCrfShopStock,
} from "@modules/map/crf/crf-shop.controller";

/**
 * modules/map/crf-shop.routes.ts
 *
 * Read-only proxy routes backing the CRF souvenir tab's catalog browsing UI
 * (list / view-one / live-stock-check). Separate from crf.routes.ts because
 * these don't touch a specific CRF at all — no crfId, no ownership check,
 * no Prisma. Gated the same way as the rest of CRF (authorize("MAP","CRF",
 * "read")) so access follows the same module permission.
 *
 * Mount in app.ts the same way crf.routes.ts is mounted, e.g.:
 *   app.use("/api/v1/crf-shop", crfShopRoutes);
 */
const router = Router();

router.use(requireAuth); // sets req.user
router.use(firstAuthRequestPerDay);

router.get(
  "/catalog",
  authorize("MAP", "CRF", "read"),
  asyncHandler(getCrfShopCatalog),
);
router.get(
  "/catalog/:key",
  authorize("MAP", "CRF", "read"),
  asyncHandler(getCrfShopProduct),
);
router.post(
  "/stock-check",
  authorize("MAP", "CRF", "read"),
  asyncHandler(checkCrfShopStock),
);

export default router;
