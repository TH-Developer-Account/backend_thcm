import { prisma } from "@shared/config/prisma";
import { parseFile, RawRow } from "@import-export/utils/fileParser";
import { downloadFromS3 } from "@shared/utils/aws-s3.services";
import {
  ParticipantType,
  ParticipantStatus,
} from "../../prisma/generated/prisma/client";
import {
  parseParticipantTypeLabel,
  parseParticipantStatusLabel,
} from "./utils/leadParticipantLabels";

const BATCH_SIZE = 500;

export type RowError = { row: number; field: string; message: string };

export type ImportResult = {
  totalRows: number;
  processedRows: number;
  failedRows: number;
  errors: RowError[];
  allRawRows: RawRow[];
};

type ValidLead = {
  epcId: string;
  name: string;
  email: string | null;
  phone: string | null;
  companyName: string | null;
  dealership: string | null;
  location: string | null;
  district: string | null;
  state: string | null;
  eventDate: Date | null;
  participantType: ParticipantType | null;
  participantStatus: ParticipantStatus | null;
  machineModel: string | null;
  machineSerial: string | null;
  valueOfServiceOffers: number | null;
  valueOfPartsOffers: number | null;
  valueOfPartsBilled: number | null;
  notes: string | null;
};

// ── Explicit type guard — used instead of relying on `if (result.valid)` ─────
// control-flow narrowing, since that was failing to narrow the union
// correctly in this project's TS setup despite the return type being a
// correctly-shaped discriminated union.
function isValidRow<TValid, TError>(
  result: ({ valid: true } & TValid) | ({ valid: false } & TError),
): result is { valid: true } & TValid {
  return result.valid === true;
}

function parseOptionalDecimal(
  raw: string | undefined,
): { value: number | null } | { error: string } {
  const trimmed = raw?.trim();
  if (!trimmed) return { value: null };
  const parsed = Number(trimmed);
  if (Number.isNaN(parsed))
    return { error: `must be a number, got "${trimmed}"` };
  if (parsed < 0) return { error: "must not be negative" };
  return { value: parsed };
}

function parseOptionalDate(
  raw: string | undefined,
): { value: Date | null } | { error: string } {
  const trimmed = raw?.trim();
  if (!trimmed) return { value: null };
  const parsed = new Date(trimmed);
  if (isNaN(parsed.getTime())) return { error: `invalid date "${trimmed}"` };
  return { value: parsed };
}

function validateRow(
  raw: RawRow,
  rowIndex: number,
  epcId: string,
): { valid: true; lead: ValidLead } | { valid: false; errors: RowError[] } {
  const errors: RowError[] = [];
  const displayRow = rowIndex + 2;

  const name = raw["name"]?.trim() ?? "";
  const email = raw["email"]?.trim() || null;
  const phone = raw["phone"]?.trim() || null;
  const companyName = raw["company name"]?.trim() || null;
  const dealership = raw["dealership"]?.trim() || null;
  const location = raw["location"]?.trim() || null;
  const district = raw["district"]?.trim() || null;
  const state = raw["state"]?.trim() || null;
  const machineModel = raw["machine model"]?.trim() || null;
  const machineSerial = raw["machine serial"]?.trim() || null;
  const notes = raw["notes"]?.trim() || null;

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

  const eventDateResult = parseOptionalDate(raw["event date"]);
  if ("error" in eventDateResult) {
    errors.push({
      row: displayRow,
      field: "event date",
      message: eventDateResult.error,
    });
  }

  const participantTypeRaw = raw["participant type"]?.trim();
  let participantType: ParticipantType | null = null;
  if (participantTypeRaw) {
    const parsed = parseParticipantTypeLabel(participantTypeRaw);
    if (!parsed) {
      errors.push({
        row: displayRow,
        field: "participant type",
        message: `unrecognized participant type "${participantTypeRaw}"`,
      });
    } else {
      participantType = parsed;
    }
  }

  const participantStatusRaw = raw["participant status"]?.trim();
  let participantStatus: ParticipantStatus | null = null;
  if (participantStatusRaw) {
    const parsed = parseParticipantStatusLabel(participantStatusRaw);
    if (!parsed) {
      errors.push({
        row: displayRow,
        field: "participant status",
        message: `unrecognized participant status "${participantStatusRaw}"`,
      });
    } else {
      participantStatus = parsed;
    }
  }

  const valueFields = [
    ["value of service offers", raw["value of service offers"]],
    ["value of parts offers", raw["value of parts offers"]],
    ["value of parts billed", raw["value of parts billed"]],
  ] as const;

  const parsedValues: Record<string, number | null> = {};
  for (const [field, rawValue] of valueFields) {
    const result = parseOptionalDecimal(rawValue);
    if ("error" in result) {
      errors.push({ row: displayRow, field, message: result.error });
    } else {
      parsedValues[field] = result.value;
    }
  }

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    lead: {
      epcId,
      name,
      email,
      phone,
      companyName,
      dealership,
      location,
      district,
      state,
      eventDate: "error" in eventDateResult ? null : eventDateResult.value,
      participantType,
      participantStatus,
      machineModel,
      machineSerial,
      valueOfServiceOffers: parsedValues["value of service offers"],
      valueOfPartsOffers: parsedValues["value of parts offers"],
      valueOfPartsBilled: parsedValues["value of parts billed"],
      notes,
    },
  };
}

async function batchInsert(leads: ValidLead[]): Promise<void> {
  for (let i = 0; i < leads.length; i += BATCH_SIZE) {
    await prisma.lead.createMany({ data: leads.slice(i, i + BATCH_SIZE) });
  }
}

export async function importLeadsFromS3(
  epcId: string,
  fileS3Key: string,
  fileMimeType: string,
): Promise<ImportResult> {
  const epc = await prisma.eventProposal.findUnique({
    where: { id: epcId },
    select: { id: true },
  });
  if (!epc) throw new Error(`Event Proposal not found: ${epcId}`);

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

  const validLeads: ValidLead[] = [];
  const allErrors: RowError[] = [];

  for (let i = 0; i < rows.length; i++) {
    const result = validateRow(rows[i], i, epcId);

    if (isValidRow<{ lead: ValidLead }, { errors: RowError[] }>(result)) {
      validLeads.push(result.lead);
    } else {
      allErrors.push(...result.errors);
    }
  }

  if (validLeads.length > 0) await batchInsert(validLeads);

  return {
    totalRows,
    processedRows: validLeads.length,
    failedRows: totalRows - validLeads.length,
    errors: allErrors,
    allRawRows: allErrors.length > 0 ? rows : [],
  };
}
