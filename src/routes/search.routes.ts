import { Router } from "express";
import {
  searchPincodes,
  searchBank,
  searchBankBranches,
} from "../controllers/search.controller";
import { requireAuth } from "../middleware/auth.middleware"; // adjust import to your actual auth middleware

const router = Router();

// GET /api/v1/pincodes/search?q=560034
// GET /api/v1/pincodes/search?q=Bengaluru
router.get("/pincodes", requireAuth, searchPincodes);
router.get("/banks", requireAuth, searchBank);

router.get("/banks/:bankName/branches", requireAuth, searchBankBranches);

export default router;
