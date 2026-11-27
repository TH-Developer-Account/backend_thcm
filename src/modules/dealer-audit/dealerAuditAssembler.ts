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
  assessmentDate: Date | null;
  location: string;
  address: string;
  facility: string;
  functions: { name: string; maxScore: number; score: number }[];
  percent: number;
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
          addresses: {
            orderBy: { isDefault: "desc" },
            take: 1,
            select: { address: true, city: true, state: true, pincode: true },
          },
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

  // Same rule that produced the stored final score: nothing submitted = 0,
  // auto-finalised = dealer score, otherwise the reviewer's score.
  const functions = new Map<
    string,
    { name: string; maxScore: number; score: number }
  >();
  const items = instance.template.items.map((item) => {
    const response = latestByItem.get(item.id);
    const sectionName = item.functionName || "General";
    if (item.requiresScore) {
      const row = functions.get(sectionName) ?? {
        name: sectionName,
        maxScore: 0,
        score: 0,
      };
      row.maxScore += item.maxScore ?? 0;
      row.score += !instance.submittedAt
        ? 0
        : instance.escalatedAt
          ? (response?.dealerScore ?? 0)
          : response?.isNotApplicable
            ? 0
            : (response?.reviewerScore ?? response?.dealerScore ?? 0);
      functions.set(sectionName, row);
    }
    return {
      sectionName,
      label: item.label,
      dealerScore: response?.dealerScore ?? null,
      reviewerScore: response?.reviewerScore ?? null,
      reviewerRemark: response?.reviewerRemark ?? null,
    };
  });

  const rows = [...functions.values()];
  const maxScore =
    instance.maxScore ?? rows.reduce((sum, row) => sum + row.maxScore, 0);
  const totalScore =
    instance.finalScore ?? rows.reduce((sum, row) => sum + row.score, 0);

  const address = instance.businessPartner.addresses[0];
  const text = instance.template.items
    .map((i) => `${i.functionName ?? ""} ${i.categoryName ?? ""}`)
    .join(" ")
    .toLowerCase();
  const facility = ["Sales", "Service", "Parts"]
    .filter((name) => text.includes(name.toLowerCase()))
    .join(" | ");

  return {
    instanceId: instance.id,
    dealerName: instance.businessPartner.bpName,
    dealerEmail: instance.businessPartner.users[0]?.email ?? null,
    officeType: instance.officeType,
    periodLabel: instance.periodLabel,
    templateName: instance.template.name,
    closedAt: instance.closedAt,
    assessmentDate: instance.submittedAt ?? instance.closedAt,
    location: address?.city ?? "",
    address: [address?.address, address?.city, address?.state, address?.pincode]
      .filter(Boolean)
      .join(", "),
    facility,
    functions: rows,
    percent: maxScore > 0 ? Math.round((totalScore / maxScore) * 1000) / 10 : 0,
    items,
    totalScore,
    maxScore,
  };
}
