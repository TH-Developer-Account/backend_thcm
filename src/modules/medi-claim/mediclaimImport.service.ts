import { prisma } from "@shared/config/prisma";
import { parseFile, RawRow } from "@import-export/utils/fileParser";
import { downloadFromS3 } from "@shared/utils/aws-s3.services";
import { addMailJob } from "@mail/mail.service";
import { issueAccessToken } from "@shared/services/accessToken.services";
import { generateMedicalClaimReferenceNumber } from "./mediclaim.helper";
import { APP_KEY } from "./mediclaim.routes";

// ─────────────────────────────────────────────────────────────────────────────
// mediclaimImport.service.ts
//
// Bulk counterpart to initiateMedicalClaim (mediclaim.controller.ts) — same
// per-row create/token/email logic, run over every row of an uploaded file
// instead of a single request body.
//
// WHY row-level errors without aborting: same reasoning as
// leadImport.services.ts — a file with 400 valid rows and 5 bad rows should
// still initiate the 400 valid claims; the user sees exactly which rows
// failed and why.
//
// WHY no batchInsert/createMany here (unlike leadImport.services.ts): each
// row needs its own reference number, access token, and initiation email —
// there's no bulk-insert shortcut once per-row side effects are required,
// so rows are processed one at a time.
// ─────────────────────────────────────────────────────────────────────────────

// ── Types ─────────────────────────────────────────────────────────────────────

export type RowError = {
  row: number; // 1-based, accounting for header row
  field: string;
  message: string;
};

export type MedicalClaimImportResult = {
  totalRows: number;
  processedRows: number;
  failedRows: number;
  errors: RowError[];
  // Only populated when failedRows > 0 — mirrors leadImport.services.ts,
  // lets the worker build the error Excel without re-downloading the file.
  allRawRows: RawRow[];
};

type ValidClaimRow = {
  employeeName: string;
  ticketNumber: string | null;
  mobile: string;
  email: string;
};

// ── Row validation ────────────────────────────────────────────────────────────
// Same required fields initiateMedicalClaim enforces inline for a single
// claim. Pure function — no DB calls, no side effects.

function validateRow(
  raw: RawRow,
  rowIndex: number,
): { valid: true; row: ValidClaimRow } | { valid: false; errors: RowError[] } {
  const errors: RowError[] = [];

  const employeeName = raw["employeename"]?.trim() ?? "";
  const ticketNumber = raw["ticketnumber"]?.trim() || null;
  const mobile = raw["mobile"]?.trim() ?? "";
  const email = raw["email"]?.trim() ?? "";

  // row index is 0-based from parser; +2 accounts for header row and 1-based display
  const displayRow = rowIndex + 2;

  if (employeeName.length < 2) {
    errors.push({
      row: displayRow,
      field: "employeeName",
      message: "employeeName is required and must be at least 2 characters",
    });
  }

  if (!mobile) {
    errors.push({
      row: displayRow,
      field: "mobile",
      message: "mobile is required",
    });
  }

  if (!email) {
    errors.push({
      row: displayRow,
      field: "email",
      message: "email is required",
    });
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push({
      row: displayRow,
      field: "email",
      message: "invalid email format",
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, row: { employeeName, ticketNumber, mobile, email } };
}

// ── Single-row initiation ─────────────────────────────────────────────────────
// Same steps as initiateMedicalClaim: create claim + issue access token +
// activity log, in one transaction, then email the claim-form link.

async function initiateClaimFromRow(
  row: ValidClaimRow,
  workspaceId: string,
  initiatedById: string,
): Promise<void> {
  const result = await prisma.$transaction(async (tx) => {
    const referenceNumber = generateMedicalClaimReferenceNumber(
      row.employeeName,
    );
    const created = await tx.medicalClaim.create({
      data: {
        workspaceId,
        initiatedById,
        referenceNumber,
        employeeName: row.employeeName,
        ticketNumber: row.ticketNumber,
        mobile: row.mobile,
        email: row.email,
      },
    });

    const tokenRecord = await issueAccessToken(APP_KEY, created.id, tx);

    await tx.activityLog.create({
      data: {
        subjectType: APP_KEY,
        subjectId: created.id,
        actorId: initiatedById,
        action: "MEDICAL_CLAIM_INITIATED",
      },
    });

    return { created, tokenRecord };
  });

  await addMailJob({
    to: row.email,
    subject: "Medical Claim — Action Required",
    templateName: "medi-claim-initiation",
    templateData: {
      employeeName: row.employeeName,
      formUrl: `${process.env.FRONTEND_URL}/medical-claim-form/${result.tokenRecord.token}`,
    },
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function importMedicalClaimsFromS3(
  workspaceId: string,
  initiatedById: string,
  fileS3Key: string,
  fileMimeType: string,
): Promise<MedicalClaimImportResult> {
  const fileBuffer = await downloadFromS3(fileS3Key);
  const { rows, totalRows } = parseFile(fileBuffer, fileMimeType);

  if (totalRows === 0) {
    return {
      totalRows: 0,
      processedRows: 0,
      failedRows: 0,
      errors: [],
      allRawRows: [],
    };
  }

  const allErrors: RowError[] = [];
  let processedRows = 0;

  for (let i = 0; i < rows.length; i++) {
    const validated = validateRow(rows[i], i);

    if (validated.valid === false) {
      allErrors.push(...validated.errors);
      continue;
    }

    try {
      await initiateClaimFromRow(validated.row, workspaceId, initiatedById);
      processedRows++;
    } catch (error) {
      // A DB/mail failure on one row (e.g. duplicate reference number
      // collision) shouldn't abort the rest of the file — same
      // no-full-file-rejection guarantee as leadImport.services.ts.
      allErrors.push({
        row: i + 2,
        field: "row",
        message:
          error instanceof Error ? error.message : "Failed to initiate claim",
      });
    }
  }

  return {
    totalRows,
    processedRows,
    failedRows: totalRows - processedRows,
    errors: allErrors,
    allRawRows: allErrors.length > 0 ? rows : [],
  };
}
