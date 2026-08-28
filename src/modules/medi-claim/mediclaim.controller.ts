import { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";

import { resolveWorkspaceId } from "@import-export/export.controller";
import { notify } from "@notifications/notification.services";
import { addMailJob } from "@mail/mail.service";
import { getSignedImageUrl } from "@shared/utils/aws-s3.services";
import { buildXlsxBuffer } from "@import-export/utils/xlsxWriter";
import { createPendingLog } from "@import-export/importExportLog.services";
import { mediclaimExportQueue } from "./mediclaimExport.queue";
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
  resolveMedicalClaimListingOrderBy,
  MedicalClaimListingTab,
  resolveMedicalClaimSubjectIdsForApprovalTab,
  generateMedicalClaimReferenceNumber,
  computeMedicalClaimEligibility,
  upsertMedicalClaimBills,
  mapMedicalClaimToXlsxRow,
  MEDICAL_CLAIM_EXPORT_COLUMN_WIDTHS,
} from "./mediclaim.helper";

const attachSignedUrlsToBills = async <T extends { s3Key: string | null }>(
  bills: T[],
): Promise<Array<T & { fileUrl: string | null }>> =>
  Promise.all(
    bills.map(async (bill, index) => ({
      ...bill,
      attachmentIndex: index,
      fileUrl: bill.s3Key ? await getSignedImageUrl(bill.s3Key) : null,
    })),
  );

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
    const { id: claimId } = req.medicalClaimAccessToken!.claim;
    const claim = await prisma.medicalClaim.findUnique({
      where: { id: claimId },
      include: { bills: true },
    });
    if (!claim) throw new ApiError(404, "Medical claim not found");

    const billsWithSignedUrls = await attachSignedUrlsToBills(claim.bills);

    res.status(200).json({
      success: true,
      data: {
        ...claim,
        bills: billsWithSignedUrls,
      },
    });
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
    if (!grade)
      throw new ApiError(400, "Grade is required to compute eligibility");
    if (!mobile) throw new ApiError(400, "A mobile number is required");

    let guestPlainPassword: string | null = null;

    const result = await prisma.$transaction(async (tx) => {
      // ── Guest linking — identity key is mobile, same as vendor onboarding ──
      const existingGuest = await tx.guest.findUnique({ where: { mobile } });
      const guest =
        existingGuest ??
        (await tx.guest.create({ data: { mobile, email, name: patientName } }));

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
          declarationAcceptedAt: new Date(),
          signatureName,
          signatureDate,
          submittedAt: new Date(),
          status: "IN_PROGRESS",
        },
      });

      const totalClaimed = await upsertMedicalClaimBills(
        tx,
        updated.id,
        bills,
        files,
        { requireAttachment: true },
      );
      await tx.medicalClaim.update({
        where: { id: updated.id },
        data: { totalClaimed },
      });

      await markAccessTokenUsed(tokenId, tx);

      const app = await tx.app.findUnique({
        where: { key: APP_KEY },
        select: { id: true },
      });
      if (!app) {
        throw new ApiError(404, `App "${APP_KEY}" not found`);
      }

      // Workflow assignment — same marker vendor onboarding's sendForApproval
      // uses; assignWorkflow's real signature wasn't in the files reviewed
      const assigned = await assignWorkflow(tx, {
        subjectType: APP_KEY,
        subjectId: updated.id,
        workspaceId: updated.workspaceId,
        appId: app.id,
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
    const bills = req.body.bills ? JSON.parse(req.body.bills) : [];
    const files = (req.files as Express.Multer.File[]) ?? [];

    if (!Array.isArray(bills)) {
      throw new ApiError(400, "Bills must be an array");
    }

    await prisma.$transaction(async (tx) => {
      await tx.medicalClaim.update({
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

      await upsertMedicalClaimBills(tx, claim.id, bills, files, {
        requireAttachment: false,
      });
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

    const orderBy = resolveMedicalClaimListingOrderBy(
      req.query.sortBy as string,
      req.query.sortOrder as string,
    );

    const [items, total] = await Promise.all([
      prisma.medicalClaim.findMany({
        where,
        skip: reqPageIndex * reqPageSize,
        take: reqPageSize,
        orderBy,
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

    const billsWithSignedUrls = await attachSignedUrlsToBills(claim.bills);
    res.status(200).json({
      success: true,
      data: {
        ...claim,
        bills: billsWithSignedUrls,
        activeWorkflow,
      },
    });
  } catch (error) {
    next(error);
  }
};

// GET /medical-claims/export/:id — single-record XLSX download.
// Synchronous (no queue): a single row is cheap to build, so this mirrors
// exportVendorOnboardingById rather than the queued bulk export below.
export const exportMedicalClaimById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const workspaceId = await resolveWorkspaceId(userId);

    const claim = await prisma.medicalClaim.findUnique({
      where: { id: id as string },
    });
    if (!claim) throw new ApiError(404, "Medical claim not found");
    if (claim.workspaceId !== workspaceId) {
      throw new ApiError(
        403,
        "Medical claim does not belong to your workspace",
      );
    }

    const row = mapMedicalClaimToXlsxRow(claim);

    const buffer = buildXlsxBuffer([
      {
        name: "MedicalClaim",
        rows: [row],
        columnWidths: MEDICAL_CLAIM_EXPORT_COLUMN_WIDTHS,
      },
    ]);

    const filename = `medical-claim-${claim.referenceNumber}.xlsx`;

    res.status(200);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (error) {
    next(error);
  }
};

// POST /medical-claims/export — enqueues a bulk export scoped to the same
// tab/search filters as listMedicalClaims ("export what I'm currently
// looking at"). Mirrors enqueueVendorOnboardingExport.
export const enqueueMedicalClaimExport = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const {
      tab = "claims",
      search = "",
      format = "xlsx",
    }: {
      tab?: MedicalClaimListingTab;
      search?: string;
      format?: "csv" | "xlsx";
    } = req.body;

    if (!["csv", "xlsx"].includes(format)) {
      throw new ApiError(400, "format must be 'csv' or 'xlsx'");
    }

    const workspaceId = await resolveWorkspaceId(userId);

    const approvalSubjectIds =
      tab === "pendingOnMe" || tab === "approvedByMe"
        ? await resolveMedicalClaimSubjectIdsForApprovalTab(userId, tab)
        : undefined;

    // jobId generated up front, log row created before enqueue — same fix
    // as export.controller.ts's enqueueEpcExport, avoiding the race where
    // the worker could pick up the job before the log row exists.
    const jobId = randomUUID();

    const logId = await createPendingLog({
      type: "MEDICAL_CLAIM_EXPORT",
      triggeredById: userId,
      workspaceId,
      jobId,
    });

    const job = await mediclaimExportQueue.add(
      "medical-claim-export",
      {
        workspaceId,
        userId,
        tab,
        search,
        approvalSubjectIds,
        format,
        requestedBy: userId,
        logId,
      },
      { jobId },
    );

    res.status(202).json({
      success: true,
      message: "Medical claim export job queued",
      jobId: job.id,
      logId,
      pollUrl: `/api/v1/medical-claims/export/status/${job.id}`,
    });
  } catch (error) {
    next(error);
  }
};

// GET /medical-claims/export/status/:jobId
export const getMedicalClaimExportStatus = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const { jobId } = req.params;
    const job = await mediclaimExportQueue.getJob(jobId as string);

    if (!job) throw new ApiError(404, "Export job not found");

    const state = await job.getState();
    const progress = job.progress as Record<string, unknown>;

    res.status(200).json({
      success: true,
      jobId,
      status: state,
      downloadUrl: progress?.downloadUrl ?? null,
      failedReason: state === "failed" ? job.failedReason : undefined,
    });
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

    const latestClarification = await prisma.activityLog.findFirst({
      where: {
        subjectType: APP_KEY,
        subjectId: claim.id,
        action: "CLARIFY",
      },
      orderBy: { createdAt: "desc" },
      select: { metadata: true, createdAt: true },
    });

    const billsWithSignedUrls = await attachSignedUrlsToBills(claim.bills);
    res.status(200).json({
      success: true,
      data: {
        ...claim,
        correctionReason:
          (latestClarification?.metadata as { reason?: string } | null)
            ?.reason ?? null,
        bills: billsWithSignedUrls,
      },
    });
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

      const totalClaimed = await upsertMedicalClaimBills(
        tx,
        claim.id,
        bills,
        files,
        { requireAttachment: true },
      );

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
        { type: "guest", id: guestId },
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

// PATCH /medical-claims/:id/bills/approved-amounts
// Non-external approvers only, on the claim's currently active stage —
// separate step before the approve action itself, per product decision.
export const setMedicalClaimBillApprovedAmounts = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;
    const { bills } = req.body; // [{ billId, approvedClaimAmount }]
    if (!userId) throw new ApiError(401, "Unauthorized");
    if (!Array.isArray(bills) || bills.length === 0) {
      throw new ApiError(400, "At least one bill amount is required");
    }

    const claim = await prisma.medicalClaim.findUnique({
      where: { id: id as string },
    });
    if (!claim) throw new ApiError(404, "Medical claim not found");

    const activeWorkflow = await prisma.workflowInstance.findFirst({
      where: {
        subjectType: "MEDICAL_CLAIM",
        subjectId: claim.id,
        isActive: true,
      },
      select: { id: true },
    });
    if (!activeWorkflow)
      throw new ApiError(404, "No active workflow found for this claim");

    const approval = await prisma.approval.findFirst({
      where: {
        approverId: userId,
        isExternalApprover: false,
        stage: {
          workflowId: activeWorkflow.id,
          isCurrentIteration: true,
          status: "IN_PROGRESS",
        },
      },
    });
    if (!approval) {
      throw new ApiError(
        403,
        "You are not authorized to edit amounts for this claim's current stage",
      );
    }

    const claimBillIds = new Set(
      (
        await prisma.medicalClaimBill.findMany({
          where: { claimId: claim.id },
          select: { id: true },
        })
      ).map((b) => b.id),
    );
    const invalid = bills.find((b: any) => !claimBillIds.has(b.billId));
    if (invalid)
      throw new ApiError(
        400,
        `Bill ${invalid.billId} does not belong to this claim`,
      );

    const claimBills = await prisma.medicalClaimBill.findMany({
      where: { claimId: claim.id },
      select: { id: true, amount: true },
    });
    const amountByBillId = new Map(claimBills.map((b) => [b.id, b.amount]));

    bills.map((b: any) =>
      prisma.medicalClaimBill.update({
        where: { id: b.billId },
        data: {
          approved: true,
          approvedClaimAmount:
            b.approvedClaimAmount ?? amountByBillId.get(b.billId),
        },
      }),
    );

    res
      .status(200)
      .json({ success: true, message: "Approved amounts updated" });
  } catch (error) {
    next(error);
  }
};

// PATCH /medical-claims/:id/bills/remarks
// Non-external approvers only, on the claim's currently active stage — same
// authorization scope as setMedicalClaimBillApprovedAmounts, kept as a
// separate endpoint per product decision (remarks and amounts are distinct
// actions even though they're reviewed together in the same UI pass).
export const setMedicalClaimBillRemarks = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;
    const { bills } = req.body; // [{ billId, remarks }]
    if (!userId) throw new ApiError(401, "Unauthorized");
    if (!Array.isArray(bills) || bills.length === 0) {
      throw new ApiError(400, "At least one bill remark is required");
    }

    const claim = await prisma.medicalClaim.findUnique({
      where: { id: id as string },
    });
    if (!claim) throw new ApiError(404, "Medical claim not found");

    const activeWorkflow = await prisma.workflowInstance.findFirst({
      where: {
        subjectType: "MEDICAL_CLAIM",
        subjectId: claim.id,
        isActive: true,
      },
      select: { id: true },
    });
    if (!activeWorkflow)
      throw new ApiError(404, "No active workflow found for this claim");

    const approval = await prisma.approval.findFirst({
      where: {
        approverId: userId,
        isExternalApprover: false,
        stage: {
          workflowId: activeWorkflow.id,
          isCurrentIteration: true,
          status: "IN_PROGRESS",
        },
      },
    });
    if (!approval) {
      throw new ApiError(
        403,
        "You are not authorized to edit remarks for this claim's current stage",
      );
    }

    const claimBillIds = new Set(
      (
        await prisma.medicalClaimBill.findMany({
          where: { claimId: claim.id },
          select: { id: true },
        })
      ).map((b) => b.id),
    );
    const invalid = bills.find((b: any) => !claimBillIds.has(b.billId));
    if (invalid) {
      throw new ApiError(
        400,
        `Bill ${invalid.billId} does not belong to this claim`,
      );
    }

    await Promise.all(
      bills.map((b: any) =>
        prisma.medicalClaimBill.update({
          where: { id: b.billId },
          data: { remarks: b.remarks ?? null },
        }),
      ),
    );

    res.status(200).json({ success: true, message: "Remarks updated" });
  } catch (error) {
    next(error);
  }
};
