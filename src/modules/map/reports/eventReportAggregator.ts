import { prisma } from "@shared/config/prisma";
import { Prisma } from "../../../prisma/generated/prisma/client";
import {
  EventReportTemplateConfig,
  OutcomeComputation,
} from "./eventReportTemplate.types";
import {
  computeMachineStudySummary,
  MachineStudySummary,
} from "./machineSummary";

// ─────────────────────────────────────────────────────────────────────────────
// eventReportAggregator.ts
//
// Given a resolved EventReportTemplateConfig and an epcId, resolves every
// inputField/outcomeField to an actual value — reading from the EPC directly
// for EPC_FIELD inputs, and from Lead rows or MachineStudy(+cycles) for
// outcomes depending on the template's sourceType.
//
// Deliberately has no knowledge of pdfmake, S3, or EventReport.status — this
// module's only job is "template + epcId → resolved values". Keeping it pure
// data-resolution means it can be unit-tested against a template config and
// a handful of fake Lead/MachineStudy rows without touching a queue or a PDF.
// ─────────────────────────────────────────────────────────────────────────────

export type ResolvedField =
  | { reportLabel: string; value: unknown }
  | {
      reportLabel: string;
      tataHitachiValue: unknown;
      competitionValue: unknown;
    };

export type ResolvedReportData = {
  inputFields: ResolvedField[];
  outcomeFields: ResolvedField[];
};

// ── Path traversal for EPC_FIELD inputs (e.g. "event_name.title") ────────────

function getByPath(obj: Record<string, any>, path: string): unknown {
  return path.split(".").reduce<any>((acc, key) => acc?.[key], obj);
}

// Prisma Decimal fields need explicit conversion — plain arithmetic on them
// silently does string concatenation instead of addition.
function toNumber(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return value instanceof Prisma.Decimal ? value.toNumber() : value;
}

// ── Input fields — always EPC-sourced or free text, same resolution regardless of sourceType ──

async function resolveInputFields(
  template: EventReportTemplateConfig,
  epcId: string,
  eventHighlights: string | null,
): Promise<ResolvedField[]> {
  const epc = await prisma.eventProposal.findUnique({
    where: { id: epcId },
    include: { event_name: { select: { title: true } } },
  });

  if (!epc)
    throw new Error(
      `EventProposal not found while resolving report inputs: ${epcId}`,
    );

  return template.inputFields.map((field) => {
    if (field.source.kind === "FREE_TEXT") {
      return { reportLabel: field.reportLabel, value: eventHighlights };
    }
    return {
      reportLabel: field.reportLabel,
      value: getByPath(epc, field.source.path) ?? null,
    };
  });
}

// ── LEAD_FORM outcome resolution ──────────────────────────────────────────────

function resolveLeadFormComputation(
  computation: OutcomeComputation,
  leads: {
    name: string;
    phone: string | null;
    email: string | null;
    companyName: string | null;
    dealership: string | null;
    location: string | null;
    district: string | null;
    state: string | null;
    eventDate: Date | null;
    machineModel: string | null;
    machineSerial: string | null;
    participantType: string | null;
    participantStatus: string | null;
    valueOfServiceOffers: Prisma.Decimal | null;
    valueOfPartsOffers: Prisma.Decimal | null;
    valueOfPartsBilled: Prisma.Decimal | null;
  }[],
): unknown {
  switch (computation.kind) {
    case "COUNT_ALL":
      return leads.length;

    case "COUNT_BY_PARTICIPANT_TYPE": {
      const values = Array.isArray(computation.value)
        ? computation.value
        : [computation.value];
      return leads.filter(
        (l) => l.participantType && values.includes(l.participantType as any),
      ).length;
    }

    case "COUNT_BY_PARTICIPANT_STATUS":
      return leads.filter((l) => l.participantStatus === computation.value)
        .length;

    case "COUNT_UNIQUE": {
      const values = leads
        .map((l) => l[computation.field])
        .filter((v): v is string => !!v);
      return new Set(values.map((v) => v.trim().toLowerCase())).size;
    }

    case "LIST_UNIQUE_VALUES": {
      const values = leads
        .map((l) => l[computation.field])
        .filter((v): v is string => !!v);
      const unique = [...new Set(values.map((v) => v.trim()))];
      return unique.length > 0 ? unique.join(", ") : null;
    }

    case "UNIQUE_VALUES": {
      const values = leads
        .map((l) => l[computation.field])
        .filter((v): v is string => !!v);
      const unique = [...new Set(values.map((v) => v.trim()))];
      return unique.length > 0 ? unique.join(", ") : null;
    }

    case "EARLIEST_DATE": {
      const dates = leads
        .map((l) => l.eventDate)
        .filter((d): d is Date => d !== null);
      if (dates.length === 0) return null;
      return new Date(Math.min(...dates.map((d) => d.getTime())));
    }

    case "LATEST_DATE": {
      const dates = leads
        .map((l) => l.eventDate)
        .filter((d): d is Date => d !== null);
      if (dates.length === 0) return null;
      return new Date(Math.max(...dates.map((d) => d.getTime())));
    }

    case "SUM": {
      const total = leads.reduce(
        (sum, l) => sum + toNumber(l[computation.field]),
        0,
      );
      return total;
    }

    case "MACHINE_STUDY_SUMMARY":
    case "DATA_FORM_VALUE":
      throw new Error(
        `Computation kind "${computation.kind}" is not valid for a LEAD_FORM template — check the registry entry.`,
      );

    default: {
      const _exhaustive: never = computation;
      throw new Error(
        `Unhandled OutcomeComputation kind: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

async function resolveLeadFormOutcomes(
  template: EventReportTemplateConfig,
  epcId: string,
): Promise<ResolvedField[]> {
  const leads = await prisma.lead.findMany({ where: { epcId } });

  return template.outcomeFields.map((field) => ({
    reportLabel: field.reportLabel,
    value: resolveLeadFormComputation(field.computation, leads),
  }));
}

// ── DATA_FORM outcome resolution ──────────────────────────────────────────────

function resolveDataFormComputation(
  computation: OutcomeComputation,
  study: Record<string, unknown>,
  summary: MachineStudySummary,
): unknown {
  switch (computation.kind) {
    case "DATA_FORM_VALUE":
      return study[computation.field] ?? null;
    case "MACHINE_STUDY_SUMMARY":
      return summary[computation.field];
    default:
      throw new Error(
        `Computation kind "${computation.kind}" is not valid for a DATA_FORM template — check the registry entry.`,
      );
  }
}

async function resolveSingleMachineStudy(
  epcId: string,
  isCompetitorMachine: boolean,
): Promise<{ study: Record<string, unknown>; summary: MachineStudySummary }> {
  const study = await prisma.machineStudy.findUnique({
    where: { epcId_isCompetitorMachine: { epcId, isCompetitorMachine } },
    include: { cycles: true },
  });

  if (!study) {
    throw new Error(
      `MachineStudy not found for epcId=${epcId}, isCompetitorMachine=${isCompetitorMachine} — this should have been caught by submitReport's guard.`,
    );
  }

  const summary = computeMachineStudySummary(
    {
      fuelType: study.fuelType,
      dieselTopUpLtr: study.dieselTopUpLtr
        ? toNumber(study.dieselTopUpLtr)
        : null,
      startKwhReading: study.startKwhReading
        ? toNumber(study.startKwhReading)
        : null,
      endKwhReading: study.endKwhReading ? toNumber(study.endKwhReading) : null,
    },
    study.cycles.map((c) => ({
      timeTakenSeconds: c.timeTakenSeconds,
      bucketPasses: c.bucketPasses,
      payloadKg: c.payloadKg ? toNumber(c.payloadKg) : null,
      remarks: c.remarks,
    })),
  );

  return { study, summary };
}

async function resolveDataFormOutcomes(
  template: EventReportTemplateConfig,
  epcId: string,
): Promise<ResolvedField[]> {
  if (!template.dualVariant) {
    const { study, summary } = await resolveSingleMachineStudy(epcId, false);
    return template.outcomeFields.map((field) => ({
      reportLabel: field.reportLabel,
      value: resolveDataFormComputation(field.computation, study, summary),
    }));
  }

  // Benchmarking — resolve both machines, pair every field into one row.
  const [tataHitachi, competition] = await Promise.all([
    resolveSingleMachineStudy(epcId, false),
    resolveSingleMachineStudy(epcId, true),
  ]);

  return template.outcomeFields.map((field) => ({
    reportLabel: field.reportLabel,
    tataHitachiValue: resolveDataFormComputation(
      field.computation,
      tataHitachi.study,
      tataHitachi.summary,
    ),
    competitionValue: resolveDataFormComputation(
      field.computation,
      competition.study,
      competition.summary,
    ),
  }));
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function resolveEventReportData(
  template: EventReportTemplateConfig,
  epcId: string,
  eventHighlights: string | null,
): Promise<ResolvedReportData> {
  const inputFields = await resolveInputFields(
    template,
    epcId,
    eventHighlights,
  );

  const outcomeFields =
    template.sourceType === "LEAD_FORM"
      ? await resolveLeadFormOutcomes(template, epcId)
      : await resolveDataFormOutcomes(template, epcId);

  return { inputFields, outcomeFields };
}
