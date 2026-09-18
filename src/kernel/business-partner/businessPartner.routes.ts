import { Router } from "express";

import asyncHandler from "@shared/middleware/async.middleware";
import { requireAuth, requireSuperAdmin } from "@auth/auth.middleware";

import {
  createBusinessPartner,
  getBusinessPartnerById,
  listBusinessPartners,
  updateBusinessPartner,
  deactivateBusinessPartner,
  createBusinessPartnerContact,
  listBusinessPartnerContacts,
  getBusinessPartnerContactById,
  updateBusinessPartnerContact,
  deleteBusinessPartnerContact,
  createBusinessPartnerAddress,
  listBusinessPartnerAddresses,
  getBusinessPartnerAddressById,
  updateBusinessPartnerAddress,
  deleteBusinessPartnerAddress,
} from "./businessPartner.controller";

const router = Router();

router.use(requireAuth);
router.use(requireSuperAdmin);

router.post("/", asyncHandler(createBusinessPartner));
router.get("/", asyncHandler(listBusinessPartners));
router.get("/:id", asyncHandler(getBusinessPartnerById));
router.patch("/:id", asyncHandler(updateBusinessPartner));
router.delete("/:id", asyncHandler(deactivateBusinessPartner));

router.post(
  "/:businessPartnerId/contacts",
  asyncHandler(createBusinessPartnerContact),
);
router.get(
  "/:businessPartnerId/contacts",
  asyncHandler(listBusinessPartnerContacts),
);
router.get(
  "/:businessPartnerId/contacts/:id",
  asyncHandler(getBusinessPartnerContactById),
);
router.patch(
  "/:businessPartnerId/contacts/:id",
  asyncHandler(updateBusinessPartnerContact),
);
router.delete(
  "/:businessPartnerId/contacts/:id",
  asyncHandler(deleteBusinessPartnerContact),
);

router.post(
  "/:businessPartnerId/addresses",
  asyncHandler(createBusinessPartnerAddress),
);
router.get(
  "/:businessPartnerId/addresses",
  asyncHandler(listBusinessPartnerAddresses),
);
router.get(
  "/:businessPartnerId/addresses/:id",
  asyncHandler(getBusinessPartnerAddressById),
);
router.patch(
  "/:businessPartnerId/addresses/:id",
  asyncHandler(updateBusinessPartnerAddress),
);
router.delete(
  "/:businessPartnerId/addresses/:id",
  asyncHandler(deleteBusinessPartnerAddress),
);

export default router;
