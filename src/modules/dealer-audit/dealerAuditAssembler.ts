import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";

export interface DealerAuditPdfData {
  instanceId: string;
  // The dealership's name (official, for the report header) and its
  // primary contact's email (the actual send-to address) — the instance
  // belongs to the BusinessPartner, not to one specific User, so these two
  // no longer come off a single "dealer" relation the way they used to.
  dealerName: string;
  dealerEmail: string | null;
  officeType: string;
  periodLabel: string;
  templateName: string;
  closedAt: Date | null;
  items: {
    sectionName: string;
    label: string;
    dealerScore: number | null;
    reviewerScore: number | null;
    reviewerRemark: string | null;
  }[];
  totalScore: number;
  maxScore: number;
}

// Deliberately reads reviewerScore, not dealerScore, as the score of record
// for the report — the reviewer's number is what was actually approved;
// the dealer's self-score is context, not the final figure.
export async function assembleDealerAuditPdfData(
  instanceId: string,
): Promise<DealerAuditPdfData> {
  const instance = await prisma.dealerAuditInstance.findUnique({
    where: { id: instanceId },
    include: {
      businessPartner: {
        select: {
          bpName: true,
          // Same "primary contact" concept as dealerAudit.service.ts's
          // getPrimaryContactUser — duplicated inline rather than
          // imported, matching this file's existing boundary (it stays a
          // self-contained data-in/layout-out module, not a consumer of
          // the app service; see how pickLatestPerItem is re-derived
          // locally below instead of imported too).
          users: {
            where: { isDefaultContact: true, is_active: true },
            select: { email: true },
            take: 1,
          },
        },
      },
      template: { include: { items: { orderBy: { order: "asc" } } } },
      responses: true,
    },
  });
  if (!instance) throw new ApiError(404, "Audit instance not found");

  // Latest iteration per item — same rule used everywhere else this
  // history is read, never the raw response rows directly.
  const latestByItem = new Map<string, (typeof instance.responses)[number]>();
  for (const response of instance.responses) {
    const current = latestByItem.get(response.itemId);
    if (!current || response.iteration > current.iteration) {
      latestByItem.set(response.itemId, response);
    }
  }

  let totalScore = 0;
  let maxScore = 0;
  const items = instance.template.items.map((item) => {
    const response = latestByItem.get(item.id);
    if (response?.reviewerScore != null && item.maxScore != null) {
      totalScore += response.reviewerScore;
      maxScore += item.maxScore;
    }
    return {
      sectionName: item.sectionName,
      label: item.label,
      dealerScore: response?.dealerScore ?? null,
      reviewerScore: response?.reviewerScore ?? null,
      reviewerRemark: response?.reviewerRemark ?? null,
    };
  });

  return {
    instanceId: instance.id,
    dealerName: instance.businessPartner.bpName,
    dealerEmail: instance.businessPartner.users[0]?.email ?? null,
    officeType: instance.officeType,
    periodLabel: instance.periodLabel,
    templateName: instance.template.name,
    closedAt: instance.closedAt,
    items,
    totalScore,
    maxScore,
  };
}
