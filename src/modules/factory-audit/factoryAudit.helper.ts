import { prisma as defaultPrisma } from "@shared/config/prisma";
import { Prisma, PartCategory } from "../../prisma/generated/prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// factoryAuditClassification.util.ts
//
// Pure(ish) computation over already-frozen AuditCheckpointResult rows — no
// writes, safe to call as many times as needed. Deliberately its own module
// rather than living inside factoryAudit.service.ts:
//
//   - factoryAudit.service.ts calls it once, tentatively, right after
//     finalize — to build assignWorkflow's `criteria` (which template/chain
//     a submission routes to) and to render the detailed report PDF.
//   - workflowSubject.helper.ts (the shared workflow kernel every app's
//     approveStage runs through) calls it a second time, from its
//     FACTORY_AUDIT_INSTANCE postApprovalHook, to persist the ratified
//     VendorClassificationHistory row once a human has actually approved.
//
// Both calls are guaranteed to agree, since AuditCheckpointResult rows are
// immutable from the moment finalizeFactoryAuditRoundScoring creates them —
// nothing between "submitted for approval" and "approved" can change a
// checkpoint's score.
//
// workflowSubject.helper.ts's own convention (see its DEALER_AUDIT_INSTANCE
// comments) is to never import an app's *service* module, to keep the shared
// kernel from depending on app-specific business logic. A full weighted
// scoring + banding algorithm is too much to duplicate inline the way that
// file duplicates a one-line "pick latest iteration" reducer elsewhere — so
// this computation is pulled out into its own small, pure, app-agnostic
// utility instead, which both sides import. That keeps the kernel's
// boundary intact (it still isn't importing factoryAudit.service.ts) while
// keeping the actual algorithm in exactly one place.
//
// `db` defaults to the global prisma client but accepts a
// Prisma.TransactionClient too, so the postApprovalHook can call this from
// inside approveStage's own transaction rather than issuing a second,
// unrelated connection mid-transaction.
// ─────────────────────────────────────────────────────────────────────────────

type PrismaClientOrTx = typeof defaultPrisma | Prisma.TransactionClient;

// Confirmed thresholds (percent) and the PartCategory scope each band
// qualifies a vendor for going forward.
export type FactoryClassificationBand = {
  label: string;
  minPercent: number;
  maxPercent: number;
  qualifiesFor: PartCategory[];
};

export const FACTORY_CLASSIFICATION_BANDS: FactoryClassificationBand[] = [
  {
    label: "Very Good",
    minPercent: 80,
    maxPercent: 100,
    qualifiesFor: ["S", "C", "A", "GENERAL"],
  },
  {
    label: "Good",
    minPercent: 65,
    maxPercent: 80,
    qualifiesFor: ["C", "A", "GENERAL"],
  },
  {
    label: "Average",
    minPercent: 50,
    maxPercent: 65,
    qualifiesFor: ["A", "GENERAL"],
  },
  { label: "No Approval", minPercent: 0, maxPercent: 50, qualifiesFor: [] },
];

const NO_APPROVAL_BAND =
  FACTORY_CLASSIFICATION_BANDS[FACTORY_CLASSIFICATION_BANDS.length - 1];

function resolveBandByPercent(
  overallPercent: number,
): FactoryClassificationBand {
  const band = FACTORY_CLASSIFICATION_BANDS.find(
    (b) => overallPercent >= b.minPercent && overallPercent <= b.maxPercent,
  );
  return band ?? NO_APPROVAL_BAND;
}

export type FactoryAuditSectionResult = {
  sectionId: string;
  sectionName: string;
  percent: number; // 0–100
  passThreshold: number; // 0–100 (schema stores it as a 0–1 fraction; converted here)
  passed: boolean;
};

export type FactoryAuditClassificationResult = {
  overallPercent: number;
  bandLabel: string;
  qualifiesFor: PartCategory[];
  sections: FactoryAuditSectionResult[];
  sectionsFailed: FactoryAuditSectionResult[];
};

export async function computeFactoryAuditClassification(
  auditInstanceId: string,
  db: PrismaClientOrTx = defaultPrisma,
): Promise<FactoryAuditClassificationResult> {
  const results = await db.auditCheckpointResult.findMany({
    where: { auditInstanceId },
    include: { checkpoint: { include: { section: true } } },
  });

  const resultsBySectionId = new Map<string, typeof results>();
  for (const result of results) {
    const sectionId = result.checkpoint.section.id;
    const list = resultsBySectionId.get(sectionId) ?? [];
    list.push(result);
    resultsBySectionId.set(sectionId, list);
  }

  let overallEarned = 0;
  let overallWeight = 0;
  const sections: FactoryAuditSectionResult[] = [];

  for (const sectionResults of resultsBySectionId.values()) {
    const section = sectionResults[0].checkpoint.section;

    let earned = 0;
    let weight = 0;
    for (const result of sectionResults) {
      // N/A checkpoints have score: null (see AuditCheckpointResult's own
      // comment) — excluded from both numerator and denominator, same
      // convention finalizeFactoryAuditRoundScoring already applies.
      if (result.score == null) continue;
      earned += (result.score / 4) * result.checkpoint.weight;
      weight += result.checkpoint.weight;
    }

    // elevatedPassThresholdForCriticalParts deliberately not applied yet —
    // deferred by explicit product decision. Always compare against the
    // regular passThreshold for now; revisit once "critical" is confirmed.
    const sectionFraction = weight > 0 ? earned / weight : 0;
    sections.push({
      sectionId: section.id,
      sectionName: section.name,
      percent: sectionFraction * 100,
      passThreshold: section.passThreshold * 100,
      passed: sectionFraction >= section.passThreshold,
    });

    overallEarned += earned;
    overallWeight += weight;
  }

  const overallPercent =
    overallWeight > 0 ? (overallEarned / overallWeight) * 100 : 0;
  const sectionsFailed = sections.filter((s) => !s.passed);

  // Hard gate (confirmed): any failing section forces "No Approval"
  // regardless of how high the overall percentage is — a weak section
  // can't be averaged away by strong ones elsewhere.
  const band = sectionsFailed.length
    ? NO_APPROVAL_BAND
    : resolveBandByPercent(overallPercent);

  return {
    overallPercent,
    bandLabel: band.label,
    qualifiesFor: band.qualifiesFor,
    sections,
    sectionsFailed,
  };
}
