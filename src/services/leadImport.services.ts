import { prisma } from "../config/prisma";
import { parseFile, RawRow } from "../utils/fileParser";
import { downloadFromS3 } from "./aws-s3.services";

// ─────────────────────────────────────────────────────────────────────────────
// leadImport.service.ts
//
// Responsibilities:
//   1. Download file buffer from S3
//   2. Parse CSV/XLSX → RawRow[]
//   3. Validate each row, collecting row-level errors without aborting
//   4. Batch insert valid rows via createMany (batches of 500)
//   5. Return a structured result for the worker to store as job progress
//
// WHY row-level errors without aborting:
//   A file with 4000 valid rows and 50 bad rows should not be thrown away
//   entirely. The user sees exactly which rows failed and why, and the
//   valid rows are still inserted.
// ─────────────────────────────────────────────────────────────────────────────

const BATCH_SIZE = 500;

// ── Types ─────────────────────────────────────────────────────────────────────

export type RowError = {
  row: number; // 1-based, accounting for header row
  field: string;
  message: string;
};

export type ImportResult = {
  totalRows: number;
  processedRows: number;
  failedRows: number;
  errors: RowError[];
  // Returned so the worker can build the error Excel without re-downloading the file.
  // Only populated when failedRows > 0 to avoid holding raw data in memory unnecessarily.
  allRawRows: RawRow[];
};

type ValidLead = {
  epcId: string;
  name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
};

// ── Row validation ────────────────────────────────────────────────────────────
// Returns either a ValidLead or an array of RowErrors for that row.
// Pure function — no DB calls, no side effects.

function validateRow(
  raw: RawRow,
  rowIndex: number,
  epcId: string,
): { valid: true; lead: ValidLead } | { valid: false; errors: RowError[] } {
  const errors: RowError[] = [];

  const name = raw["name"]?.trim() ?? "";
  const email = raw["email"]?.trim() || null;
  const phone = raw["phone"]?.trim() || null;
  const notes = raw["notes"]?.trim() || null;

  // row index is 0-based from parser; +2 accounts for header row and 1-based display
  const displayRow = rowIndex + 2;

  if (name.length < 2) {
    errors.push({
      row: displayRow,
      field: "name",
      message: "name is required and must be at least 2 characters",
    });
  }

  if (!email && !phone) {
    errors.push({
      row: displayRow,
      field: "email/phone",
      message: "at least one of email or phone is required",
    });
  }

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push({
      row: displayRow,
      field: "email",
      message: "invalid email format",
    });
  }

  if (phone && !/^\+?[0-9]{7,15}$/.test(phone)) {
    errors.push({
      row: displayRow,
      field: "phone",
      message: "invalid phone format",
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, lead: { epcId, name, email, phone, notes } };
}

// ── Batch insert ──────────────────────────────────────────────────────────────
// Splits validLeads into chunks of BATCH_SIZE and inserts each chunk.
// Using createMany for performance — one DB round-trip per batch.

async function batchInsert(leads: ValidLead[]): Promise<void> {
  for (let i = 0; i < leads.length; i += BATCH_SIZE) {
    const batch = leads.slice(i, i + BATCH_SIZE);
    await prisma.lead.createMany({ data: batch });
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function importLeadsFromS3(
  epcId: string,
  fileS3Key: string,
  fileMimeType: string,
): Promise<ImportResult> {
  // 1. Verify EPC exists before processing file
  const epc = await prisma.eventProposal.findUnique({
    where: { id: epcId },
    select: { id: true },
  });

  if (!epc) {
    throw new Error(`Event Proposal not found: ${epcId}`);
  }

  // 2. Download file from S3
  const fileBuffer = await downloadFromS3(fileS3Key);

  // 3. Parse file → raw rows
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

  // 4. Validate all rows, collect errors without aborting
  const validLeads: ValidLead[] = [];
  const allErrors: RowError[] = [];

  for (let i = 0; i < rows.length; i++) {
    const result = validateRow(rows[i], i, epcId);

    if (result.valid === true) {
      validLeads.push(result.lead);
    } else {
      allErrors.push(...result.errors);
    }
  }

  // 5. Batch insert valid rows
  if (validLeads.length > 0) {
    await batchInsert(validLeads);
  }

  return {
    totalRows,
    processedRows: validLeads.length,
    failedRows: totalRows - validLeads.length,
    errors: allErrors,
    // Pass raw rows back so worker can build the error Excel without re-fetching from S3
    allRawRows: allErrors.length > 0 ? rows : [],
  };
}
