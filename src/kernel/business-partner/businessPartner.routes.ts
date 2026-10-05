import { Router } from "express";

import asyncHandler from "@shared/middleware/async.middleware";
import {
  requireAdministrationAccess,
  requireAuth,
  requireSuperAdmin,
} from "@auth/auth.middleware";

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

// App admins need to read business partners (e.g. to pick one when creating
// a user) but only a super admin may change them.
const canRead = [requireAdministrationAccess];
const canWrite = [requireSuperAdmin];

router.use(requireAuth);

router.get("/", canRead, asyncHandler(listBusinessPartners));
router.get("/:id", canRead, asyncHandler(getBusinessPartnerById));
router.post("/", canWrite, asyncHandler(createBusinessPartner));
router.patch("/:id", canWrite, asyncHandler(updateBusinessPartner));
router.delete("/:id", canWrite, asyncHandler(deactivateBusinessPartner));

router.get(
  "/:businessPartnerId/contacts",
  canRead,
  asyncHandler(listBusinessPartnerContacts),
);
router.get(
  "/:businessPartnerId/contacts/:id",
  canRead,
  asyncHandler(getBusinessPartnerContactById),
);
router.post(
  "/:businessPartnerId/contacts",
  canWrite,
  asyncHandler(createBusinessPartnerContact),
);
router.patch(
  "/:businessPartnerId/contacts/:id",
  canWrite,
  asyncHandler(updateBusinessPartnerContact),
);
router.delete(
  "/:businessPartnerId/contacts/:id",
  canWrite,
  asyncHandler(deleteBusinessPartnerContact),
);

router.get(
  "/:businessPartnerId/addresses",
  canRead,
  asyncHandler(listBusinessPartnerAddresses),
);
router.get(
  "/:businessPartnerId/addresses/:id",
  canRead,
  asyncHandler(getBusinessPartnerAddressById),
);
router.post(
  "/:businessPartnerId/addresses",
  canWrite,
  asyncHandler(createBusinessPartnerAddress),
);
router.patch(
  "/:businessPartnerId/addresses/:id",
  canWrite,
  asyncHandler(updateBusinessPartnerAddress),
);
router.delete(
  "/:businessPartnerId/addresses/:id",
  canWrite,
  asyncHandler(deleteBusinessPartnerAddress),
);

export default router;
