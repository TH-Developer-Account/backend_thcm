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
// COST_PER_PARTICIPANT_STATUS is the one computation that needs BOTH
// sources at once (EPC budget ÷ Lead count) — the EPC is now fetched once
// at the top and its eventBudget threaded into the Lead-side resolver,
// rather than each side querying independently.
// ─────────────────────────────────────────────────────────────────────────────

export type ResolvedField =
  | { reportLabel: string; value: unknown }
  | {
      reportLabel: string;
      tataHitachiValue: unknown;
      competitionValue: unknown;
    }
  | {
      reportLabel: string;
      percentBetter: number | null;
      betterVariant: "tataHitachi" | "competition" | null;
    };

export type ResolvedReportData = {
  inputFields: ResolvedField[];
  outcomeFields: ResolvedField[];
};

function getByPath(obj: Record<string, any>, path: string): unknown {
  return path.split(".").reduce<any>((acc, key) => acc?.[key], obj);
}

function toNumber(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return value instanceof Prisma.Decimal ? value.toNumber() : value;
}

// ── Input fields — always EPC-sourced or free text ────────────────────────

function resolveInputFieldsFromEpc(
  template: EventReportTemplateConfig,
  epc: Record<string, any>,
  eventHighlights: string | null,
): ResolvedField[] {
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

type LeadForAggregation = {
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
};

function resolveLeadFormComputation(
  computation: OutcomeComputation,
  leads: LeadForAggregation[],
  eventBudget: number | null,
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

    case "COST_PER_PARTICIPANT_STATUS": {
      if (eventBudget === null) return null;
      const count = leads.filter(
        (l) => l.participantStatus === computation.status,
      ).length;
      return count > 0 ? eventBudget / count : null;
    }

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
      return leads.reduce((sum, l) => sum + toNumber(l[computation.field]), 0);
    }

    case "MACHINE_STUDY_SUMMARY":
    case "BENCHMARK_PERCENT_BETTER":
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
  eventBudget: number | null,
): Promise<ResolvedField[]> {
  const leads = await prisma.lead.findMany({ where: { epcId } });

  return template.outcomeFields.map((field) => ({
    reportLabel: field.reportLabel,
    value: resolveLeadFormComputation(field.computation, leads, eventBudget),
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
        `Computation kind "${computation.kind}" is not valid for a single-machine resolution — check the registry entry.`,
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

function resolveBenchmarkComparison(
  computation: Extract<
    OutcomeComputation,
    { kind: "BENCHMARK_PERCENT_BETTER" }
  >,
  tataHitachiSummary: MachineStudySummary,
  competitionSummary: MachineStudySummary,
): ResolvedField {
  const tataValue = tataHitachiSummary[computation.field];
  const competitionValue = competitionSummary[computation.field];

  if (tataValue == null || competitionValue == null || competitionValue === 0) {
    return {
      reportLabel: computation.label,
      percentBetter: null,
      betterVariant: null,
    };
  }

  // Ltr/Hr is a fuel-consumption-rate metric — lower is better; Tons/Hr and
  // Tons/Ltr are output metrics — higher is better. Sign convention flips
  // accordingly so "percentBetter" reads positive when Tata Hitachi wins.
  const isLowerBetter = computation.field === "ltrPerHr";
  const rawPercent = ((tataValue - competitionValue) / competitionValue) * 100;
  const percentBetter = isLowerBetter ? -rawPercent : rawPercent;

  return {
    reportLabel: computation.label,
    percentBetter: Math.abs(percentBetter),
    betterVariant: percentBetter >= 0 ? "tataHitachi" : "competition",
  };
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

  const [tataHitachi, competition] = await Promise.all([
    resolveSingleMachineStudy(epcId, false),
    resolveSingleMachineStudy(epcId, true),
  ]);

  return template.outcomeFields.map((field) => {
    if (field.computation.kind === "BENCHMARK_PERCENT_BETTER") {
      return resolveBenchmarkComparison(
        field.computation,
        tataHitachi.summary,
        competition.summary,
      );
    }

    return {
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
    };
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function resolveEventReportData(
  template: EventReportTemplateConfig,
  epcId: string,
  eventHighlights: string | null,
): Promise<ResolvedReportData> {
  const epc = await prisma.eventProposal.findUnique({
    where: { id: epcId },
    include: {
      event_name: { select: { title: true } },
      epf: { select: { eventBudget: true } },
    },
  });

  if (!epc)
    throw new Error(
      `EventProposal not found while resolving report data: ${epcId}`,
    );

  const inputFields = resolveInputFieldsFromEpc(template, epc, eventHighlights);
  const eventBudget =
    epc.epf?.eventBudget != null ? toNumber(epc.epf.eventBudget) : null;

  const outcomeFields =
    template.sourceType === "LEAD_FORM"
      ? await resolveLeadFormOutcomes(template, epcId, eventBudget)
      : await resolveDataFormOutcomes(template, epcId);

  return { inputFields, outcomeFields };
}
