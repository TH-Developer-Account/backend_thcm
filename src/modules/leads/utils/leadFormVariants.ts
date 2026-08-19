import { prisma } from "@shared/config/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// leadFormVariant.ts
//
// Maps an EventName's reportTemplateKey to which Lead-capture form variant
// applies, and which fields that variant shows. Single source of truth so
// the frontend never hardcodes "Service Campaign needs machine fields" —
// it asks this endpoint instead.
//
// Grouping derived directly from which Lead fields each template's
// outcomeFields actually reference in eventReportTemplate.definitions.ts —
// not a separate judgment call, just reading off what's already there.
// ─────────────────────────────────────────────────────────────────────────────

export type LeadFormVariant = "FORM_1" | "FORM_2" | "FORM_3" | "NOT_APPLICABLE";

export type LeadFormFieldKey =
  | "name"
  | "email"
  | "phone"
  | "companyName"
  | "dealership"
  | "location"
  | "district"
  | "state"
  | "eventDate"
  | "participantType"
  | "participantStatus"
  | "machineModel"
  | "machineSerial"
  | "valueOfServiceOffers"
  | "valueOfPartsOffers"
  | "valueOfPartsBilled"
  | "notes";

const FORM_1_FIELDS: LeadFormFieldKey[] = [
  "name",
  "email",
  "phone",
  "companyName",
  "dealership",
  "location",
  "district",
  "state",
  "eventDate",
  "participantType",
  "participantStatus",
  "notes",
];

const FORM_2_FIELDS: LeadFormFieldKey[] = [
  "name",
  "phone",
  "companyName",
  "dealership",
  "location",
  "district",
  "state",
  "eventDate",
  "machineModel",
  "machineSerial",
  "valueOfServiceOffers",
  "valueOfPartsOffers",
  "notes",
];

const FORM_3_FIELDS: LeadFormFieldKey[] = [
  "name",
  "phone",
  "companyName",
  "dealership",
  "location",
  "district",
  "state",
  "eventDate",
  "valueOfPartsBilled",
  "valueOfPartsOffers",
  "notes",
];

const TEMPLATE_KEY_TO_VARIANT: Record<string, LeadFormVariant> = {
  CUSTOMER_MEET: "FORM_1",
  CUSTOMER_MEET_KEY_ACCOUNT: "FORM_1",
  PRODUCT_LAUNCH: "FORM_1",
  LOAN_MELA: "FORM_1",
  EXHIBITION: "FORM_1",
  ROADSHOW: "FORM_1",
  PLANT_VISIT: "FORM_1",
  TRAINING_TO_CUSTOMER_STAFF: "FORM_1",
  TRAINING_TO_OPERATORS: "FORM_1",
  TRAINING_TO_MECHANICS: "FORM_1",
  OPERATOR_MEET: "FORM_1",
  FINANCIER_MEET: "FORM_1",
  GENERAL_REPORT: "FORM_1",
  SERVICE_CAMPAIGN: "FORM_2",
  PARTS_MELA: "FORM_3",
  MACHINE_DEMONSTRATION: "NOT_APPLICABLE",
  STAND_ALONE_FUEL_PRODUCTION_STUDY: "NOT_APPLICABLE",
  FUEL_PRODUCTION_BENCHMARKING: "NOT_APPLICABLE",
};

const VARIANT_FIELDS: Record<LeadFormVariant, LeadFormFieldKey[]> = {
  FORM_1: FORM_1_FIELDS,
  FORM_2: FORM_2_FIELDS,
  FORM_3: FORM_3_FIELDS,
  NOT_APPLICABLE: [],
};

export async function resolveLeadFormConfig(
  eventNameId: string,
): Promise<{ variant: LeadFormVariant; fields: LeadFormFieldKey[] }> {
  const eventName = await prisma.eventName.findUnique({
    where: { id: eventNameId },
    select: { reportTemplateKey: true },
  });

  const variant: LeadFormVariant = eventName?.reportTemplateKey
    ? (TEMPLATE_KEY_TO_VARIANT[eventName.reportTemplateKey] ?? "NOT_APPLICABLE")
    : "NOT_APPLICABLE";

  return { variant, fields: VARIANT_FIELDS[variant] };
}
