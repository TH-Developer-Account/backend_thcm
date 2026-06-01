import { Router } from "express";
import { searchPincodes } from "../controllers/pincode.controller";
import { requireAuth } from "../middleware/auth.middleware"; // adjust import to your actual auth middleware

const router = Router();

// GET /api/v1/pincodes/search?q=560034
// GET /api/v1/pincodes/search?q=Bengaluru
router.get("/search", requireAuth, searchPincodes);

export default router;
