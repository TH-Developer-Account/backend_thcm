import {
  ParticipantType,
  ParticipantStatus,
} from "../../../prisma/generated/prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// Single source of truth mapping between the Prisma enum values and the
// human-readable labels used in import/export spreadsheets.
//
// WHY this exists: leadImport.service.ts needs label → enum (parsing a
// spreadsheet cell), leadExport.service.ts needs enum → label (writing a
// spreadsheet cell). Both derive from the same pairs, so drift between an
// import label and its export counterpart is impossible by construction.
// ─────────────────────────────────────────────────────────────────────────────

export const PARTICIPANT_TYPE_LABELS: Record<ParticipantType, string> = {
  CUSTOMER: "Customer",
  CUSTOMER_KEY_ACCOUNT: "Customer-Key Account",
  CUSTOMER_STAFF: "Customer Staff",
  VENDOR_PARTNER: "Vendor Partner",
  HITACHI_REPRESENTATIVE: "Hitachi Representative",
  TATA_HITACHI_EXECUTIVE: "Tata Hitachi Executive",
  DEALERSHIP_EXECUTIVE: "Dealership Executive",
  FINANCIER_EXECUTIVE: "Financier Executive",
  MACHINE_OPERATOR: "Machine Operator",
  MACHINE_MECHANIC: "Machine Mechanic",
  OTHER: "Other",
};

export const PARTICIPANT_STATUS_LABELS: Record<ParticipantStatus, string> = {
  COLD_ENQUIRY: "Cold Enquiry",
  WARM_ENQUIRY: "Warm Enquiry",
  HOT_ENQUIRY: "Hot Enquiry",
  EVENT_ATTENDEE: "Event attendee",
  FELICITATION: "Felicitation",
  KEY_HANDOVER: "Key Handover",
  BOOKING: "Booking",
};

// ── Reverse lookups (label → enum), keyed lowercase for case-insensitive match ──

const buildReverseMap = <T extends string>(
  labels: Record<T, string>,
): Record<string, T> =>
  Object.fromEntries(
    (Object.entries(labels) as [T, string][]).map(([enumValue, label]) => [
      label.toLowerCase(),
      enumValue,
    ]),
  );

const PARTICIPANT_TYPE_BY_LABEL = buildReverseMap(PARTICIPANT_TYPE_LABELS);
const PARTICIPANT_STATUS_BY_LABEL = buildReverseMap(PARTICIPANT_STATUS_LABELS);

export function parseParticipantTypeLabel(
  label: string,
): ParticipantType | undefined {
  return PARTICIPANT_TYPE_BY_LABEL[label.trim().toLowerCase()];
}

export function parseParticipantStatusLabel(
  label: string,
): ParticipantStatus | undefined {
  return PARTICIPANT_STATUS_BY_LABEL[label.trim().toLowerCase()];
}
