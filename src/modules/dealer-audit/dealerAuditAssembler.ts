import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";

export interface DealerAuditPdfData {
  instanceId: string;
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
      dealer: { select: { first_name: true, last_name: true, email: true } },
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
    dealerName: `${instance.dealer.first_name} ${instance.dealer.last_name}`,
    dealerEmail: instance.dealer.email,
    officeType: instance.officeType,
    periodLabel: instance.periodLabel,
    templateName: instance.template.name,
    closedAt: instance.closedAt,
    items,
    totalScore,
    maxScore,
  };
}
