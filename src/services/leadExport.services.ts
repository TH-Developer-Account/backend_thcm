import { prisma } from "../config/prisma";
import { rowsToCsvBuffer } from "../utils/csvWriter";
import { buildXlsxBuffer } from "../utils/xlsxWriter";

// ─────────────────────────────────────────────────────────────────────────────
// leadExport.service.ts
//
// Queries leads (optionally scoped to an EPC) and returns a CSV or XLSX buffer
// ready to be uploaded to S3.
//
// WHY return a buffer and not stream directly to S3:
//   Lead exports are at most a few thousand rows — the buffer fits comfortably
//   in memory. Streaming adds complexity that isn't justified at this scale.
//   The EPC full dump (epcExport.service.ts) uses streaming because it can
//   span tens of thousands of rows across deep joins.
// ─────────────────────────────────────────────────────────────────────────────

type LeadExportOptions = {
  epcId?: string;
  format: "csv" | "xlsx";
};

type LeadExportRow = {
  "Lead ID": string;
  "EPC ID": string;
  "Proposal Number": string;
  Name: string;
  Email: string;
  Phone: string;
  Notes: string;
  "Created At": string;
};

// ── Query ─────────────────────────────────────────────────────────────────────

async function fetchLeads(epcId?: string): Promise<LeadExportRow[]> {
  const leads = await prisma.lead.findMany({
    where: epcId ? { epcId } : undefined,
    orderBy: { created_at: "asc" },
    include: {
      epc: {
        select: { proposal_number: true },
      },
    },
  });

  return leads.map((lead) => ({
    "Lead ID": lead.id,
    "EPC ID": lead.epcId,
    "Proposal Number": lead.epc.proposal_number,
    Name: lead.name,
    Email: lead.email ?? "",
    Phone: lead.phone ?? "",
    Notes: lead.notes ?? "",
    "Created At": lead.created_at.toISOString(),
  }));
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function exportLeadsToBuffer(
  options: LeadExportOptions,
): Promise<{ buffer: Buffer; filename: string }> {
  const rows = await fetchLeads(options.epcId);

  const timestamp = new Date().toISOString().slice(0, 10);
  const scope = options.epcId ? `epc-${options.epcId.slice(0, 8)}` : "all";

  if (options.format === "csv") {
    const buffer = rowsToCsvBuffer(rows);
    return { buffer, filename: `leads-${scope}-${timestamp}.csv` };
  }

  const buffer = buildXlsxBuffer([
    {
      name: "Leads",
      rows,
      columnWidths: {
        "Lead ID": 36,
        "EPC ID": 36,
        "Proposal Number": 20,
        Name: 25,
        Email: 30,
        Phone: 15,
        Notes: 40,
        "Created At": 25,
      },
    },
  ]);

  return { buffer, filename: `leads-${scope}-${timestamp}.xlsx` };
}
