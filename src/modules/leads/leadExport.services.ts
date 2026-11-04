import { prisma } from "@shared/config/prisma";
import { rowsToCsvBuffer } from "@import-export/utils/csvWriter";
import { buildXlsxBuffer } from "@import-export/utils/xlsxWriter";
import {
  PARTICIPANT_TYPE_LABELS,
  PARTICIPANT_STATUS_LABELS,
} from "@leads/utils/leadParticipantLabels";

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
  "Company Name": string;
  Dealership: string;
  Location: string;
  District: string;
  State: string;
  "Event Date": string;
  "Participant Type": string;
  "Participant Status": string;
  "Machine Model": string;
  "Machine Serial": string;
  "Value of Service Offers": string;
  "Value of Parts Offers": string;
  "Value of Parts Billed": string;
  Notes: string;
  "Created At": string;
};

async function fetchLeads(epcId?: string): Promise<LeadExportRow[]> {
  const leads = await prisma.lead.findMany({
    where: epcId ? { epcId } : undefined,
    orderBy: { created_at: "asc" },
    include: { epc: { select: { proposal_number: true } } },
  });

  return leads.map((lead) => ({
    "Lead ID": lead.id,
    "EPC ID": lead.epcId,
    "Proposal Number": lead.epc.proposal_number,
    Name: lead.name,
    Email: lead.email ?? "",
    Phone: lead.phone ?? "",
    "Company Name": lead.companyName ?? "",
    Dealership: lead.dealership ?? "",
    Location: lead.location ?? "",
    District: lead.district ?? "",
    State: lead.state ?? "",
    "Event Date": lead.eventDate
      ? lead.eventDate.toISOString().slice(0, 10)
      : "",
    "Participant Type": lead.participantType
      ? PARTICIPANT_TYPE_LABELS[lead.participantType]
      : "",
    "Participant Status": lead.participantStatus
      ? PARTICIPANT_STATUS_LABELS[lead.participantStatus]
      : "",
    "Machine Model": lead.machineModel ?? "",
    "Machine Serial": lead.machineSerial ?? "",
    "Value of Service Offers": lead.valueOfServiceOffers?.toString() ?? "",
    "Value of Parts Offers": lead.valueOfPartsOffers?.toString() ?? "",
    "Value of Parts Billed": lead.valueOfPartsBilled?.toString() ?? "",
    Notes: lead.notes ?? "",
    "Created At": lead.created_at.toISOString(),
  }));
}

export async function exportLeadsToBuffer(
  options: LeadExportOptions,
): Promise<{ buffer: Buffer; filename: string }> {
  const rows = await fetchLeads(options.epcId);
  const timestamp = new Date().toISOString().slice(0, 10);
  const scope = options.epcId ? `epc-${options.epcId.slice(0, 8)}` : "all";

  if (options.format === "csv") {
    return {
      buffer: rowsToCsvBuffer(rows),
      filename: `leads-${scope}-${timestamp}.csv`,
    };
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
        "Company Name": 25,
        Dealership: 20,
        Location: 20,
        District: 18,
        State: 15,
        "Event Date": 15,
        "Participant Type": 22,
        "Participant Status": 18,
        "Machine Model": 20,
        "Machine Serial": 20,
        "Value of Service Offers": 20,
        "Value of Parts Offers": 20,
        "Value of Parts Billed": 20,
        Notes: 40,
        "Created At": 25,
      },
    },
  ]);

  return { buffer, filename: `leads-${scope}-${timestamp}.xlsx` };
}
