import { Router } from "express";
import multer from "multer";
import asyncHandler from "@shared/middleware/async.middleware";
import { firstAuthRequestPerDay } from "@shared/middleware/dailyActiveUsers.middleware";
import { requireAuth, authorize } from "@auth/auth.middleware";
import {
  getEPFById,
  updateEPF,
  createEPF,
  uploadLineItemAttachment,
} from "@modules/map/epf/epf.controller";
import {
  LINE_ITEM_ATTACHMENT_MAX_BYTES,
  LINE_ITEM_ATTACHMENT_MIME_TYPES,
} from "./helpers/lineItemAttachement.helper";

const router = Router();

router.use(requireAuth); // sets req.user
router.use(firstAuthRequestPerDay);

// In-memory storage — matches uploadDeviationDoc's use of req.file.buffer
// elsewhere, so uploadToS3 keeps receiving a Buffer, not a disk path.
const uploadLineItemFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LINE_ITEM_ATTACHMENT_MAX_BYTES },
  fileFilter: (_req, file, callback) => {
    if (!LINE_ITEM_ATTACHMENT_MIME_TYPES[file.mimetype]) {
      return callback(new Error("Only JPEG images or PDF files are accepted"));
    }
    callback(null, true);
  },
});

router.post("/", asyncHandler(createEPF));
router.get("/:epfId", asyncHandler(getEPFById));
router.put("/:epfId", asyncHandler(updateEPF));
router.post(
  "/line-item/attachment",
  authorize("MAP", "EPF", "write"),
  uploadLineItemFile.single("file"),
  asyncHandler(uploadLineItemAttachment),
);

export default router;
