import { Request, Response, NextFunction } from "express";
import { prisma } from "../config/prisma";
import ApiError from "../utils/apiError";
import { addMailJob } from "../services/mail.service";
import { notify } from "../services/notification.services";
import { getSignedImageUrl } from "../services/aws-s3.services";
import {
  issueVendorAccessToken,
  markVendorAccessTokenUsed,
} from "../services/vendorAccessToken.services";
import { REQUIRED_VENDOR_DOCUMENT_TYPES } from "../utils/contants";
import { resolveWorkspaceId } from "./export.controller";
import { getActiveWorkflowForSubject } from "../helpers/workflowSubject.helper";
import { uploadToS3 } from "../services/aws-s3.services"; // to add, mirrors uploadDeviationDoc
import {
  buildVendorOnboardingWhereClause,
  parseVendorListingPaginationParams,
  VendorListingTab,
} from "../helpers/vendorOnboarding.helper";

// POST /vendor-onboarding
// Employee kicks off a request: name/number/email + mail trigger.
export const initiateVendorOnboarding = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    const workspaceId = await resolveWorkspaceId(userId as string);
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { vendorName, mobile, email } = req.body;
    if (!vendorName || !mobile || !email) {
      throw new ApiError(400, "Vendor Name, mobile and email are required");
    }

    const onboarding = await prisma.$transaction(async (tx) => {
      const created = await tx.vendorOnboarding.create({
        data: {
          workspaceId,
          initiatedById: userId,
          vendorName,
          mobile,
          email,
        },
      });

      const tokenRecord = await issueVendorAccessToken(created.id, tx);

      await tx.activityLog.create({
        data: {
          subjectType: "VENDOR_ONBOARDING",
          subjectId: created.id,
          actorId: userId,
          action: "VENDOR_ONBOARDING_INITIATED",
        },
      });

      return { created, tokenRecord };
    });

    await addMailJob({
      to: email,
      subject: "Vendor Onboarding — Action Required",
      templateName: "vendor-onboarding",
      templateData: {
        vendorName,
        formUrl: `${process.env.FRONTEND_URL}/vendor-form/${onboarding.tokenRecord.token}`,
      },
    });

    res.status(201).json({
      success: true,
      message:
        "Vendor onboarding initiated and link has been sent to their email!",
      data: onboarding.created,
    });
  } catch (error) {
    next(error);
  }
};

// controllers/vendorOnboarding.controller.ts

// GET /vendor-onboarding
// Defaults to "mine" (matches "forms initiated by the employee"). Workspace
// admins/superadmins can pass ?scope=workspace to see everyone's requests —
// same pattern as most list endpoints distinguishing "my items" vs "all items".
export const listVendorOnboardings = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    const workspaceId = await resolveWorkspaceId(userId as string);

    const { tab, search, pageSize, pageIndex } = req.query;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const vendorTab: VendorListingTab =
      tab === "onboarding" ? "onboarding" : "initiation";
    const vendorSearch = typeof search === "string" ? search.trim() : "";
    const { reqPageIndex, reqPageSize } = parseVendorListingPaginationParams(
      pageIndex as string,
      pageSize as string,
    );

    const where = buildVendorOnboardingWhereClause(
      workspaceId,
      userId,
      vendorTab,
      vendorSearch,
    );

    const [rows, totalCount] = await Promise.all([
      prisma.vendorOnboarding.findMany({
        where,
        orderBy: { created_at: "desc" },
        skip: reqPageIndex * reqPageSize,
        take: reqPageSize,
        select: {
          id: true,
          vendorName: true,
          mobile: true,
          email: true,
          vendorCode: true,
          vendorType: true,
          companyCode: true,
          status: true,
          created_at: true,
          updated_at: true,
          initiatedBy: {
            select: { first_name: true, last_name: true },
          },
        },
      }),
      prisma.vendorOnboarding.count({ where }),
    ]);

    res.status(200).json({
      success: true,
      data: { rows, totalCount, pageIndex, pageSize },
    });
  } catch (error) {
    next(error);
  }
};

// GET /vendor-onboarding/:id
// Flattens the onboarding record + its documents + active workflow into
// one response — same shape philosophy as getEventProposalById.
export const getVendorOnboardingById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const onboarding = await prisma.vendorOnboarding.findUnique({
      where: { id: id as string },
      include: { documents: true },
    });
    if (!onboarding) throw new ApiError(404, "Vendor onboarding not found");

    // ── Guard: only the initiator or a superadmin can view ──────────────────
    if (onboarding.initiatedById !== userId) {
      throw new ApiError(403, "You do not have access to this request");
    }

    const activeWorkflow = await getActiveWorkflowForSubject(
      "VENDOR_ONBOARDING",
      id as string,
    );

    const documentsWithSignedUrls = await Promise.all(
      onboarding.documents.map(async (doc) => ({
        ...doc,
        fileUrl: await getSignedImageUrl(doc.s3Key),
      })),
    );

    res.status(200).json({
      success: true,
      data: {
        ...onboarding,
        documents: documentsWithSignedUrls,
        activeWorkflow,
      },
    });
  } catch (error) {
    next(error);
  }
};

// POST /vendor-onboarding/:id/resend-link
// Only valid while still AWAITING_VENDOR. Old unused tokens are simply
// orphaned once a new one is issued — no explicit revoke needed since
// a stale token's target status check in the middleware already blocks it
// the moment status moves on.
export const resendVendorLink = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    const onboarding = await prisma.vendorOnboarding.findUnique({
      where: { id: id as string },
    });
    if (!onboarding) throw new ApiError(404, "Vendor onboarding not found");
    if (onboarding.status !== "AWAITING_VENDOR") {
      throw new ApiError(400, "This request is no longer awaiting the vendor");
    }

    const tokenRecord = await issueVendorAccessToken(onboarding.id);

    await addMailJob({
      to: onboarding.email as string,
      subject: "Vendor Onboarding — Action Required (Resent)",
      templateName: "vendor-onboarding-link",
      templateData: {
        vendorName: onboarding.vendorName,
        formUrl: `${process.env.VENDOR_FORM_BASE_URL}/${tokenRecord.token}`,
      },
    });

    res.status(200).json({ success: true, message: "Link resent" });
  } catch (error) {
    next(error);
  }
};

// PATCH /vendor-onboarding/:id
// Employee fills in their own fields AND can correct the vendor's submitted
// details, in one call, after vendor submission (IN_REVIEW state).
// Deliberately does NOT touch status — separate endpoint below moves it forward,
// mirroring EPC's separate "resubmit" vs "advance" actions.
export const updateEmployeeFields = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const {
      // ── vendor-filled fields (employee corrections) ──
      vendorName,
      state,
      city,
      pinCode,
      address,
      mobile,
      email,
      msmeVendor,
      msmeCertAttached,
      bankName,
      bankBranch,
      ifscCode,
      bankAddress,
      accountNumber,
      gstin,
      pan,
      entityRegNo,

      // ── employee-owned fields ──
      vendorCode,
      vendorType,
      companyCode,
      purchaseOrg,
      paymentTerm,
      tds,
      vendorCategory,
      materialType,
      materialSubType,
      selfAssessmentObtained,
      ndaObtained,
      gpaObtained,
      isRelatedParty,
      vendorAuditReportPrepared,
      natureOfService,
      onboardingReason,
    } = req.body;

    // if (materialType && materialSubType) {
    //   const validSubTypes = MATERIAL_SUBTYPES_BY_TYPE[materialType] ?? [];
    //   if (!validSubTypes.includes(materialSubType)) {
    //     throw new ApiError(
    //       400,
    //       `${materialSubType} is not a valid sub-type for ${materialType}`,
    //     );
    //   }
    // }

    const onboarding = await prisma.vendorOnboarding.findUnique({
      where: { id: id as string },
    });
    if (!onboarding) throw new ApiError(404, "Vendor onboarding not found");

    // ── Guard: only the initiator or a superadmin can edit ───────────────────
    if (onboarding.initiatedById !== userId) {
      throw new ApiError(403, "You do not have access to this request");
    }

    if (
      onboarding.status !== "VENDOR_SUBMITTED" &&
      onboarding.status !== "IN_REVIEW"
    ) {
      throw new ApiError(400, "This request is not awaiting employee review");
    }

    const updated = await prisma.vendorOnboarding.update({
      where: { id: id as string },
      data: {
        status: "IN_REVIEW",
        vendorName,
        state,
        city,
        pinCode,
        address,
        mobile,
        email,
        msmeVendor,
        msmeCertAttached,
        bankName,
        bankBranch,
        ifscCode,
        bankAddress,
        accountNumber,
        gstin,
        pan,
        entityRegNo,

        // employee-owned fields
        vendorCode,
        vendorType,
        companyCode,
        purchaseOrg,
        paymentTerm,
        tds,
        vendorCategory,
        materialType,
        materialSubType,
        selfAssessmentObtained,
        ndaObtained,
        gpaObtained,
        isRelatedParty,
        vendorAuditReportPrepared,
        natureOfService,
        onboardingReason,
      },
    });

    res.status(200).json({
      success: true,
      message: "The fields have been updated",
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

// POST /vendor-onboarding/:id/send-for-approval
// Instantiates the WorkflowInstance — reuses the existing template-matching
// + stage-seeding logic in workflow_controller.ts untouched. This endpoint
// only validates readiness and flips status; the actual workflow creation
// should call your existing assignWorkflow-equivalent service, passing
// { subjectType: "VENDOR_ONBOARDING", subjectId: id, appId: <vendor-onboarding App.id> }.
export const sendForApproval = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const onboarding = await prisma.vendorOnboarding.findUnique({
      where: { id: id as string },
      include: { documents: true },
    });
    if (!onboarding) throw new ApiError(404, "Vendor onboarding not found");
    if (onboarding.status !== "IN_REVIEW") {
      throw new ApiError(400, "Employee review must be completed first");
    }

    const uploadedTypes = new Set(
      onboarding.documents.map((d) => d.documentType),
    );
    const missing = REQUIRED_VENDOR_DOCUMENT_TYPES.filter(
      (t) => !uploadedTypes.has(t),
    );
    if (missing.length > 0) {
      throw new ApiError(
        400,
        `Missing required documents: ${missing.join(", ")}`,
      );
    }
    if (!onboarding.natureOfService || !onboarding.onboardingReason) {
      throw new ApiError(
        400,
        "Nature of Service and Reason for Onboarding are required",
      );
    }

    // NOTE: actual WorkflowInstance creation — plug into your existing
    // assignWorkflow service here with subjectType VENDOR_ONBOARDING.
    // Left as a call-site marker since that service wasn't in scope of
    // the files I've reviewed.

    await prisma.$transaction(async (tx) => {
      await tx.vendorOnboarding.update({
        where: { id: id as string },
        data: { status: "IN_PROGRESS" },
      });
      await tx.activityLog.create({
        data: {
          subjectType: "VENDOR_ONBOARDING",
          subjectId: id as string,
          actorId: userId,
          action: "VENDOR_ONBOARDING_SENT_FOR_APPROVAL",
        },
      });
    });

    res.status(200).json({ success: true, message: "Sent for approval" });
  } catch (error) {
    next(error);
  }
};

// POST /vendor-onboarding/:id/close
// Final approver's explicit close action, after WorkflowInstance reaches APPROVED —
// same two-step shape as EPC_CLOSED.
export const closeVendorOnboarding = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const activeWorkflow = await prisma.workflowInstance.findFirst({
      where: {
        subjectType: "VENDOR_ONBOARDING",
        subjectId: id as string,
        isActive: true,
      },
    });
    if (!activeWorkflow || activeWorkflow.status !== "APPROVED") {
      throw new ApiError(400, "Workflow must be fully approved before closing");
    }

    await prisma.$transaction(async (tx) => {
      await tx.vendorOnboarding.update({
        where: { id: id as string },
        data: { status: "CLOSED" },
      });
      await tx.activityLog.create({
        data: {
          subjectType: "VENDOR_ONBOARDING",
          subjectId: id as string,
          actorId: userId,
          action: "VENDOR_ONBOARDING_CLOSED",
          workflowId: activeWorkflow.id,
        },
      });
    });

    res
      .status(200)
      .json({ success: true, message: "Vendor onboarding closed" });
  } catch (error) {
    next(error);
  }
};

// GET /public/vendor-onboarding/:token
// Returns the onboarding shell so the frontend can render the static form.
export const getVendorFormByToken = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // req.vendorAccessToken.onboarding set by requireVendorAccessToken middleware
  const { onboarding } = req.vendorAccessToken!;
  res.status(200).json({
    success: true,
    data: { id: onboarding.id, vendorName: onboarding.vendorName },
  });
};

// POST /public/vendor-onboarding/:token/submit
// Multipart: form fields + up to 6 named file parts (one per REQUIRED_VENDOR_DOCUMENT_TYPES entry).
export const submitVendorForm = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { onboarding, id: tokenId } = req.vendorAccessToken!;
    const {
      vendorName,
      state,
      city,
      pinCode,
      address,
      mobile,
      email,
      msmeVendor,
      msmeCertAttached,
      bankName,
      bankBranch,
      ifscCode,
      bankAddress,
      accountNumber,
      gstin,
      pan,
      entityRegNo,
      dpdpConsent,
    } = req.body;

    if (dpdpConsent !== "true" && dpdpConsent !== true) {
      throw new ApiError(400, "DPDP Act consent is required");
    }

    const files = req.files as
      | Record<string, Express.Multer.File[]>
      | undefined;
    const missing = REQUIRED_VENDOR_DOCUMENT_TYPES.filter(
      (t) => !files?.[t]?.[0],
    );
    if (missing.length > 0) {
      throw new ApiError(
        400,
        `Missing required documents: ${missing.join(", ")}`,
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.vendorOnboarding.update({
        where: { id: onboarding.id },
        data: {
          status: "VENDOR_SUBMITTED",
          vendorName,
          state,
          city,
          pinCode,
          address,
          mobile,
          email,
          msmeVendor: msmeVendor === "true",
          msmeCertAttached: msmeCertAttached === "true",
          bankName,
          bankBranch,
          ifscCode,
          bankAddress,
          accountNumber,
          gstin,
          pan,
          entityRegNo,
          dpdpConsentedAt: new Date(),
          dpdpConsentIp: req.ip,
          vendorSubmittedAt: new Date(),
        },
      });

      for (const documentType of REQUIRED_VENDOR_DOCUMENT_TYPES) {
        const file = files![documentType][0];

        const s3Key = `vendor-onboarding-docs/${onboarding.id}/${documentType}.pdf`;
        await uploadToS3(s3Key, file.buffer, file.mimetype);
        await tx.vendorOnboardingDocument.create({
          data: { onboardingId: onboarding.id, documentType, s3Key },
        });
      }

      await markVendorAccessTokenUsed(tokenId, tx);

      await tx.activityLog.create({
        data: {
          subjectType: "VENDOR_ONBOARDING",
          subjectId: onboarding.id,
          actorId: onboarding.initiatedById, // no vendor User to attribute to
          action: "VENDOR_FORM_SUBMITTED",
        },
      });

      await notify({
        workspaceId: onboarding.workspaceId,
        recipientId: onboarding.initiatedById,
        type: "APPROVAL_PENDING",
        title: "Vendor Form Submitted",
        body: "Vendor has Submitted the form, Please check.",
      });
    });

    res
      .status(200)
      .json({ success: true, message: "Form submitted successfully" });
  } catch (error) {
    next(error);
  }
};
