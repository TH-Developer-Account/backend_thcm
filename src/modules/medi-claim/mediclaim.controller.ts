import { Request, Response, NextFunction } from "express";
import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";

import { resolveWorkspaceId } from "@import-export/export.controller";
import { notify } from "@notifications/notification.services";
import { addMailJob } from "@mail/mail.service";
import { uploadToS3 } from "@shared/utils/aws-s3.services";
import {
  issueAccessToken,
  markAccessTokenUsed,
} from "@shared/services/accessToken.services";
import { createGuestCredentials } from "@guest/guest.credential";
import {
  getActiveWorkflowForSubject,
  getResubmitAction,
  getResubmitStatus,
} from "@workflow/workflowSubject.helper";
import {
  activateFirstStageForResubmit,
  notifyStageApprovers,
  assignWorkflow,
} from "@workflow/workflow.service";
import { APP_KEY } from "./mediclaim.routes";

import {
  buildMedicalClaimWhereClause,
  parseMedicalClaimListingPaginationParams,
  MedicalClaimListingTab,
  resolveMedicalClaimSubjectIdsForApprovalTab,
  generateMedicalClaimReferenceNumber,
  computeMedicalClaimEligibility,
  getBillAttachmentExtension,
} from "./mediclaim.helper";

interface MedicalClaimBillInputRaw {
  claimHead: string;
  billNo?: string;
  billName?: string;
  billDate?: string;
  amount: number;
  attachmentIndex?: number | null; // may be missing/null before validation
}

interface MedicalClaimBillInput extends Omit<
  MedicalClaimBillInputRaw,
  "attachmentIndex"
> {
  attachmentIndex: number; // guaranteed present after validateBillAttachments
}

// ── Shared bill validation + persistence ────────────────────────────────────
// Extracted once the TS narrowing issue surfaced — one place proves AND
// types the "every bill has an attachment" guarantee, instead of two
// runtime checks that couldn't be trusted by the compiler.
function validateBillAttachments(
  bills: MedicalClaimBillInputRaw[],
  files: Express.Multer.File[],
): MedicalClaimBillInput[] {
  const missingIndex = bills.findIndex(
    (b) => b.attachmentIndex == null || !files[b.attachmentIndex],
  );
  if (missingIndex !== -1) {
    throw new ApiError(
      400,
      `An attachment is required for bill #${missingIndex + 1} (${bills[missingIndex].claimHead})`,
    );
  }
  return bills as MedicalClaimBillInput[];
}

async function persistMedicalClaimBills(
  tx: any,
  claimId: string,
  bills: MedicalClaimBillInput[],
  files: Express.Multer.File[],
) {
  for (const [index, bill] of bills.entries()) {
    const file = files[bill.attachmentIndex];
    const extension = getBillAttachmentExtension(file.mimetype);
    const s3Key = `medical-claim-bills/${claimId}/${index}-${bill.claimHead}.${extension}`;
    await uploadToS3(s3Key, file.buffer, file.mimetype);

    await tx.medicalClaimBill.create({
      data: {
        claimId,
        claimHead: bill.claimHead as any,
        billNo: bill.billNo,
        billName: bill.billName,
        billDate: bill.billDate ? new Date(bill.billDate) : null,
        amount: bill.amount,
        s3Key,
      },
    });
  }
}
// POST /medical-claims — staff initiates
export const initiateMedicalClaim = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    const workspaceId = await resolveWorkspaceId(userId as string);
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { employeeName, ticketNumber, mobile, email } = req.body;
    if (!employeeName || !mobile || !email) {
      throw new ApiError(400, "Employee name, mobile and email are required");
    }

    const result = await prisma.$transaction(async (tx) => {
      const referenceNumber = generateMedicalClaimReferenceNumber(employeeName);
      const created = await tx.medicalClaim.create({
        data: {
          workspaceId,
          initiatedById: userId,
          referenceNumber,
          employeeName,
          ticketNumber,
          mobile,
          email,
        },
      });

      const tokenRecord = await issueAccessToken(APP_KEY, created.id, tx);

      await tx.activityLog.create({
        data: {
          subjectType: APP_KEY,
          subjectId: created.id,
          actorId: userId,
          action: "MEDICAL_CLAIM_INITIATED",
        },
      });

      return { created, tokenRecord };
    });

    await addMailJob({
      to: email,
      subject: "Medical Claim — Action Required",
      templateName: "medi-claim-initiation",
      templateData: {
        employeeName,
        formUrl: `${process.env.FRONTEND_URL}/medical-claim-form/${result.tokenRecord.token}`,
      },
    });

    res.status(201).json({
      success: true,
      message: "Medical claim initiated and link has been sent to their email!",
      data: result.created,
    });
  } catch (error) {
    next(error);
  }
};

// POST /medical-claims/:id/resend-link
export const resendMedicalClaimLink = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const claim = await prisma.medicalClaim.findUnique({
      where: { id: id as string },
    });
    if (!claim) throw new ApiError(404, "Medical claim not found");
    if (claim.status !== "AWAITING_EX_EMPLOYEE") {
      throw new ApiError(
        400,
        "This claim is no longer awaiting the ex-employee's submission",
      );
    }

    const tokenRecord = await issueAccessToken(APP_KEY, claim.id);

    await addMailJob({
      to: claim.email as string,
      subject: "Medical Claim — Action Required (Reminder)",
      templateName: "medi-claim-initiation",
      templateData: {
        employeeName: claim.employeeName,
        formUrl: `${process.env.FRONTEND_URL}/medical-claim-form/${tokenRecord.token}`,
      },
    });

    res
      .status(200)
      .json({ success: true, message: "Link resent successfully" });
  } catch (error) {
    next(error);
  }
};

// GET /medical-claims/public/:token
export const getMedicalClaimFormByToken = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { claim } = req.medicalClaimAccessToken!;
    res.status(200).json({ success: true, data: claim });
  } catch (error) {
    next(error);
  }
};

// POST /medical-claims/public/:token/submit
// Workflow starts immediately on submission — no manual initiator review
// gate, unlike vendor onboarding (explicit product decision).
export const submitMedicalClaimForm = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { claim, id: tokenId } = req.medicalClaimAccessToken!;
    const {
      grade,
      location,
      patientName,
      claimCover,
      spouseName,
      medicalAdvanceTaken,
      mobile,
      email,
      declarationAccepted,
      signatureName,
      signatureDate,
    } = req.body;
    const bills = req.body.bills ? JSON.parse(req.body.bills) : [];
    const files = (req.files as Express.Multer.File[]) ?? [];

    if (!declarationAccepted)
      throw new ApiError(400, "Declaration must be accepted before submitting");
    if (!Array.isArray(bills) || bills.length === 0) {
      throw new ApiError(400, "At least one claim head entry is required");
    }
    const validatedBills = validateBillAttachments(bills, files);
    if (!grade)
      throw new ApiError(400, "Grade is required to compute eligibility");
    if (!mobile) throw new ApiError(400, "A mobile number is required");

    let guestPlainPassword: string | null = null;

    const result = await prisma.$transaction(async (tx) => {
      // ── Guest linking — identity key is mobile, same as vendor onboarding ──
      const existingGuest = await tx.guest.findUnique({ where: { mobile } });
      const guest =
        existingGuest ?? (await tx.guest.create({ data: { mobile, email } }));

      if (!existingGuest && email) {
        const { plainPassword, hashedPassword } =
          await createGuestCredentials();
        await tx.guest.update({
          where: { id: guest.id },
          data: { password: hashedPassword },
        });
        guestPlainPassword = plainPassword;
      }

      const eligibility = await computeMedicalClaimEligibility(
        tx,
        guest.id,
        grade,
      );
      if (!eligibility)
        throw new ApiError(
          400,
          `No eligibility configured for grade "${grade}"`,
        );

      const totalClaimed = validatedBills.reduce(
        (sum, b: any) => sum + Number(b.amount),
        0,
      );

      const updated = await tx.medicalClaim.update({
        where: { id: claim.id },
        data: {
          guestId: guest.id,
          grade,
          location,
          patientName,
          claimCover,
          spouseName,
          medicalAdvanceTaken,
          eligibleAmount: eligibility.eligibleAmount,
          alreadySettled: eligibility.alreadySettled,
          totalClaimed,
          declarationAcceptedAt: new Date(),
          signatureName,
          signatureDate,
          submittedAt: new Date(),
          status: "IN_PROGRESS",
        },
      });

      await persistMedicalClaimBills(tx, updated.id, validatedBills, files);
      await markAccessTokenUsed(tokenId, tx);

      // Workflow assignment — same marker vendor onboarding's sendForApproval
      // uses; assignWorkflow's real signature wasn't in the files reviewed
      const assigned = await assignWorkflow(tx, {
        subjectType: APP_KEY,
        subjectId: updated.id,
        workspaceId: updated.workspaceId,
        appId: APP_KEY,
        userId: updated.initiatedById,
      });

      await tx.activityLog.create({
        data: {
          subjectType: APP_KEY,
          subjectId: updated.id,
          actorId: updated.initiatedById,
          action: "MEDICAL_CLAIM_SUBMITTED",
        },
      });
      await tx.activityLog.create({
        data: {
          subjectType: APP_KEY,
          subjectId: updated.id,
          actorId: updated.initiatedById,
          action: "MEDICAL_CLAIM_SENT_FOR_APPROVAL",
        },
      });

      await notify({
        workspaceId: updated.workspaceId,
        recipientId: updated.initiatedById,
        type: "GENERIC",
        title: "Medical claim submitted",
        body: `${updated.employeeName ?? "The ex-employee"} has submitted their medical claim. It is now in the approval workflow.`,
      });

      return { updated, assigned };
    });

    if (result.assigned.stageOneId) {
      await notifyStageApprovers({
        workflowId: result.assigned.workflowInstance.id,
        subjectType: APP_KEY,
        subjectId: result.updated.id,
        appId: APP_KEY,
        stageId: result.assigned.stageOneId,
        approverIds: result.assigned.stageOneApproverIds,
      });
    }

    if (guestPlainPassword) {
      await addMailJob({
        to: email,
        subject: "Your Guest Portal Login",
        templateName: "guest-credentials",
        templateData: {
          email,
          password: guestPlainPassword,
          loginUrl: `${process.env.FRONTEND_URL}/guest/login`,
        },
      });
    }

    res
      .status(200)
      .json({ success: true, message: "Claim submitted successfully" });
  } catch (error) {
    next(error);
  }
};

// PATCH /medical-claims/public/:token/draft
export const saveMedicalClaimDraft = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { claim } = req.medicalClaimAccessToken!;
    const {
      grade,
      location,
      patientName,
      claimCover,
      spouseName,
      medicalAdvanceTaken,
      mobile,
      email,
    } = req.body;

    await prisma.medicalClaim.update({
      where: { id: claim.id },
      data: {
        grade,
        location,
        patientName,
        claimCover,
        spouseName,
        medicalAdvanceTaken,
        mobile,
        email,
      },
    });

    res.status(200).json({ success: true, message: "Draft saved" });
  } catch (error) {
    next(error);
  }
};

// GET /medical-claims — staff listing
export const listMedicalClaims = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    const workspaceId = await resolveWorkspaceId(userId as string);
    if (!userId) throw new ApiError(401, "Unauthorized");

    const tab = (req.query.tab as MedicalClaimListingTab) || "claims";
    const search = (req.query.search as string) || "";
    const { reqPageIndex, reqPageSize } =
      parseMedicalClaimListingPaginationParams(
        req.query.page_index as string,
        req.query.page_size as string,
      );

    const approvalSubjectIds =
      tab === "pendingOnMe" || tab === "approvedByMe"
        ? await resolveMedicalClaimSubjectIdsForApprovalTab(userId, tab)
        : undefined;

    const where = buildMedicalClaimWhereClause(
      workspaceId,
      userId,
      tab,
      search,
      approvalSubjectIds,
    );

    const [items, total] = await Promise.all([
      prisma.medicalClaim.findMany({
        where,
        skip: reqPageIndex * reqPageSize,
        take: reqPageSize,
        orderBy: { created_at: "desc" },
      }),
      prisma.medicalClaim.count({ where }),
    ]);

    res.status(200).json({
      success: true,
      data: items,
      total,
      page_index: reqPageIndex,
      page_size: reqPageSize,
    });
  } catch (error) {
    next(error);
  }
};

// GET /medical-claims/:id
export const getMedicalClaimById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    const claim = await prisma.medicalClaim.findUnique({
      where: { id: id as string },
      include: { bills: true },
    });
    if (!claim) throw new ApiError(404, "Medical claim not found");

    const activeWorkflow = await getActiveWorkflowForSubject(APP_KEY, claim.id);

    res.status(200).json({ success: true, data: { ...claim, activeWorkflow } });
  } catch (error) {
    next(error);
  }
};

// GET /medical-claims/export/:id — mirrors exportVendorOnboardingById; body
// deferred until the PDF assembler/docDefinition pair for medical claims exists
export const exportMedicalClaimById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    throw new ApiError(501, "Medical claim export not yet implemented");
  } catch (error) {
    next(error);
  }
};

// POST /medical-claims/:id/close
export const closeMedicalClaim = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const claim = await prisma.medicalClaim.findUnique({
      where: { id: id as string },
    });
    if (!claim) throw new ApiError(404, "Medical claim not found");
    if (claim.initiatedById !== userId)
      throw new ApiError(403, "You do not have access to this request");
    if (claim.status !== "APPROVED") {
      throw new ApiError(400, "Only an approved claim can be closed");
    }

    await prisma.$transaction(async (tx) => {
      await tx.medicalClaim.update({
        where: { id: claim.id },
        data: { status: "CLOSED" },
      });
      await tx.activityLog.create({
        data: {
          subjectType: APP_KEY,
          subjectId: claim.id,
          actorId: userId,
          action: "MEDICAL_CLAIM_CLOSED",
        },
      });
    });

    res.status(200).json({ success: true, message: "Claim closed" });
  } catch (error) {
    next(error);
  }
};

// GET /medical-claims/guest
export const listGuestMedicalClaims = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const guestId = req.guest!.id;
    const claims = await prisma.medicalClaim.findMany({
      where: { guestId },
      orderBy: { created_at: "desc" },
    });
    res.status(200).json({ success: true, data: claims });
  } catch (error) {
    next(error);
  }
};

// GET /medical-claims/guest/:id
export const getGuestMedicalClaimById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const guestId = req.guest!.id;
    const { id } = req.params;

    const claim = await prisma.medicalClaim.findUnique({
      where: { id: id as string },
      include: { bills: true },
    });
    if (!claim || claim.guestId !== guestId)
      throw new ApiError(404, "Claim not found");

    res.status(200).json({ success: true, data: claim });
  } catch (error) {
    next(error);
  }
};

// PATCH /medical-claims/guest/:id/resubmit — after CLARIFICATION_REQUESTED
export const resubmitGuestMedicalClaim = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const guestId = req.guest!.id;
    const { id } = req.params;
    const {
      grade,
      location,
      patientName,
      claimCover,
      spouseName,
      medicalAdvanceTaken,
    } = req.body;
    const bills = req.body.bills ? JSON.parse(req.body.bills) : [];
    const files = (req.files as Express.Multer.File[]) ?? [];

    const claim = await prisma.medicalClaim.findUnique({
      where: { id: id as string },
    });
    if (!claim) throw new ApiError(404, "Claim not found");
    if (claim.guestId !== guestId)
      throw new ApiError(403, "This claim doesn't belong to you");
    if (claim.status !== "CLARIFICATION_REQUESTED") {
      throw new ApiError(400, "This claim is not currently open for edits");
    }
    if (!Array.isArray(bills) || bills.length === 0) {
      throw new ApiError(400, "At least one claim head entry is required");
    }
    const validatedBills = validateBillAttachments(bills, files);

    await prisma.$transaction(async (tx) => {
      const eligibility = await computeMedicalClaimEligibility(
        tx,
        guestId,
        grade,
        claim.id,
      );
      if (!eligibility)
        throw new ApiError(
          400,
          `No eligibility configured for grade "${grade}"`,
        );

      const totalClaimed = validatedBills.reduce(
        (sum, b: any) => sum + Number(b.amount),
        0,
      );

      await tx.medicalClaimBill.deleteMany({ where: { claimId: claim.id } });

      await tx.medicalClaim.update({
        where: { id: claim.id },
        data: {
          grade,
          location,
          patientName,
          claimCover,
          spouseName,
          medicalAdvanceTaken,
          eligibleAmount: eligibility.eligibleAmount,
          alreadySettled: eligibility.alreadySettled,
          totalClaimed,
        },
      });

      await persistMedicalClaimBills(tx, claim.id, validatedBills, files);

      const activeWorkflow = await tx.workflowInstance.findFirst({
        where: {
          subjectType: APP_KEY,
          subjectId: claim.id,
          isActive: true,
        },
        select: { id: true },
      });
      if (!activeWorkflow)
        throw new ApiError(404, "No active workflow found for this claim");

      await activateFirstStageForResubmit(
        tx,
        activeWorkflow.id,
        claim.initiatedById, // actorId convention — guest resubmits, but actorId is still the initiator, per the established convention throughout this app
        getResubmitAction(APP_KEY),
        getResubmitStatus(APP_KEY),
      );

      await notify({
        workspaceId: claim.workspaceId,
        recipientId: claim.initiatedById,
        type: "GENERIC",
        title: "Medical claim resubmitted",
        body: `${claim.employeeName ?? "The ex-employee"} has resubmitted their claim after clarification. It is back in the approval workflow.`,
      });
    });

    res.status(200).json({
      success: true,
      message: "Claim updated and resubmitted for approval",
    });
  } catch (error) {
    next(error);
  }
};
