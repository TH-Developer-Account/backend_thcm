import { prisma } from "../config/prisma";
import { buildXlsxBuffer, SheetDefinition, XlsxRow } from "../utils/xlsxWriter";
import { rowsToCsvBuffer } from "../utils/csvWriter";
import { uploadBufferToS3 } from "./aws-s3.services";

// ─────────────────────────────────────────────────────────────────────────────
// epcExport.service.ts
//
// Produces a full EPC dump across multiple related tables.
//
// WHY cursor-batched and not a single findMany:
//   A single findMany with deep includes for 5000 EPCs would load potentially
//   200,000+ rows into Node.js memory at once. At ~1KB per row that's 200MB+
//   which will OOM a typical Node process.
//
//   Instead we cursor through EPCs in batches of BATCH_SIZE, accumulate rows
//   into three flat arrays (one per sheet), then write the file once at the end.
//
//   Memory profile: only BATCH_SIZE EPCs + their related data in memory at any
//   one time, which is safe and predictable.
//
// Sheet layout:
//   Sheet 1 — EPCs         one row per EPC
//   Sheet 2 — LineItems    one row per line item (EPF and CRF combined)
//   Sheet 3 — Workflows    one row per stage approval
//
// Adding a new sheet: add a SheetDefinition to SHEET_CONFIGS and a
// corresponding row-extractor function. No changes needed in this file's
// core logic.
// ─────────────────────────────────────────────────────────────────────────────

const BATCH_SIZE = 100;

// ── Filter types ──────────────────────────────────────────────────────────────

export type EpcExportFilters = {
  status?: string;
  departmentId?: string;
  startDate?: string;
  endDate?: string;
};

// ── Row extractor functions ───────────────────────────────────────────────────
// Each function takes one EPC (with its relations) and returns rows for
// its respective sheet. Adding a new sheet = adding one extractor here
// and one entry in buildSheetDefinitions().

type EpcWithRelations = Awaited<ReturnType<typeof fetchEpcBatch>>[number];

function extractEpcRow(epc: EpcWithRelations): XlsxRow {
  return {
    "EPC ID": epc.id,
    "Proposal Number": epc.proposal_number,
    "Event Name": epc.event_name.title,
    Status: epc.status,
    Location: epc.location,
    "From Date": epc.event_from_date.toISOString().slice(0, 10),
    "To Date": epc.event_to_date.toISOString().slice(0, 10),
    Department: epc.department.department_name,
    Region: epc.region.region_name,
    Branch: epc.branch.branch_name,
    Vertical: epc.vertical.name,
    "Budget Code": epc.budget_master.code,
    "Created At": epc.created_at.toISOString(),
  };
}

function extractLineItemRows(epc: EpcWithRelations): XlsxRow[] {
  const rows: XlsxRow[] = [];

  for (const item of epc.epf?.lineItems ?? []) {
    rows.push({
      "EPC ID": epc.id,
      "Proposal Number": epc.proposal_number,
      Type: "EPF",
      "Product Name": item.product.name,
      "Part Number": item.product.partNumber,
      Category: item.product.category,
      Quantity: Number(item.quantity),
      Rate: Number(item.rate),
      Amount: Number(item.amount),
    });
  }

  for (const item of epc.crf?.lineItems ?? []) {
    rows.push({
      "EPC ID": epc.id,
      "Proposal Number": epc.proposal_number,
      Type: "CRF",
      "Product Name": item.product.name,
      "Part Number": item.product.partNumber,
      Category: item.product.category,
      Quantity: Number(item.quantity),
      Rate: Number(item.rate),
      Amount: Number(item.amount),
    });
  }

  return rows;
}

function extractWorkflowRows(
  epc: EpcWithRelations,
  workflows: WorkflowForExport[],
): XlsxRow[] {
  const rows: XlsxRow[] = [];

  for (const workflow of workflows) {
    for (const stage of workflow.stages) {
      for (const approval of stage.approvals) {
        rows.push({
          "EPC ID": epc.id,
          "Proposal Number": epc.proposal_number,
          "Workflow Type": workflow.workflowType,
          "Workflow Status": workflow.status,
          "Stage Order": stage.stageOrder,
          "Stage Name": stage.stageName ?? "",
          Strategy: stage.strategy,
          "Approver Name": `${approval.approver.first_name} ${approval.approver.last_name}`,
          "Approver Email": approval.approver.email,
          "Approval Status": approval.status,
          "Acted At": approval.actedAt?.toISOString() ?? "",
          Reason: approval.reason ?? "",
        });
      }
    }
  }

  return rows;
}

// ── DB query ──────────────────────────────────────────────────────────────────
// Fetches one batch of EPCs starting after `cursor` (EPC id).

async function fetchEpcBatch(filters: EpcExportFilters, cursor?: string) {
  const where: Record<string, unknown> = {};

  if (filters.status) where.status = filters.status;
  if (filters.departmentId) where.department_id = filters.departmentId;
  if (filters.startDate || filters.endDate) {
    where.event_from_date = {
      ...(filters.startDate && { gte: new Date(filters.startDate) }),
      ...(filters.endDate && { lte: new Date(filters.endDate) }),
    };
  }

  return prisma.eventProposal.findMany({
    where,
    take: BATCH_SIZE,
    ...(cursor && { skip: 1, cursor: { id: cursor } }),
    orderBy: { id: "asc" }, // stable cursor ordering requires a unique field
    select: {
      id: true,
      proposal_number: true,
      status: true,
      location: true,
      event_from_date: true,
      event_to_date: true,
      created_at: true,
      event_name: { select: { title: true } },
      department: { select: { department_name: true } },
      region: { select: { region_name: true } },
      branch: { select: { branch_name: true } },
      vertical: { select: { name: true } },
      budget_master: { select: { code: true } },
      epf: {
        include: {
          lineItems: {
            include: {
              product: {
                select: { name: true, partNumber: true, category: true },
              },
            },
          },
        },
      },
      crf: {
        include: {
          lineItems: {
            include: {
              product: {
                select: { name: true, partNumber: true, category: true },
              },
            },
          },
        },
      },
      // workflows relation removed — WorkflowInstance no longer has a direct
      // FK to EventProposal (it's polymorphic via subjectType/subjectId).
      // Fetched separately per-batch in fetchWorkflowsForBatch() below.
    },
  });
}

// ── Workflow lookup (per-batch) ───────────────────────────────────────────────
//
// WorkflowInstance has no direct Prisma relation to EventProposal anymore —
// it's linked via subjectType/subjectId. One query per batch (not per EPC)
// keeps this within the same memory-bounded design the rest of the file uses:
// at most BATCH_SIZE EPCs' worth of workflow data in memory at a time.

type WorkflowForExport = {
  subjectId: string;
  workflowType: string;
  status: string;
  stages: {
    stageOrder: number;
    stageName: string | null;
    strategy: string;
    approvals: {
      status: string;
      actedAt: Date | null;
      reason: string | null;
      approver: { first_name: string; last_name: string; email: string };
    }[];
  }[];
};

async function fetchWorkflowsForBatch(
  epcIds: string[],
): Promise<Map<string, WorkflowForExport[]>> {
  const workflows = await prisma.workflowInstance.findMany({
    where: { subjectType: "EVENT_PROPOSAL", subjectId: { in: epcIds } },
    select: {
      subjectId: true,
      workflowType: true,
      status: true,
      stages: {
        select: {
          stageOrder: true,
          stageName: true,
          strategy: true,
          approvals: {
            select: {
              status: true,
              actedAt: true,
              reason: true,
              approver: {
                select: { first_name: true, last_name: true, email: true },
              },
            },
          },
        },
      },
    },
  });

  const byEpcId = new Map<string, WorkflowForExport[]>();
  for (const wf of workflows) {
    const existing = byEpcId.get(wf.subjectId) ?? [];
    existing.push(wf);
    byEpcId.set(wf.subjectId, existing);
  }
  return byEpcId;
}

// ── Sheet config builder ──────────────────────────────────────────────────────
// Converts accumulated rows into SheetDefinitions.
// To add a new sheet: add rows accumulation in the main loop + a new entry here.

function buildSheetDefinitions(
  epcRows: XlsxRow[],
  lineItemRows: XlsxRow[],
  workflowRows: XlsxRow[],
): SheetDefinition[] {
  return [
    {
      name: "EPCs",
      rows: epcRows,
      columnWidths: {
        "EPC ID": 36,
        "Proposal Number": 20,
        "Event Name": 30,
        Status: 15,
        Location: 25,
        Department: 30,
        Region: 20,
        Branch: 20,
      },
    },
    {
      name: "LineItems",
      rows: lineItemRows,
      columnWidths: {
        "EPC ID": 36,
        "Product Name": 30,
        "Part Number": 15,
        Category: 20,
      },
    },
    {
      name: "Workflows",
      rows: workflowRows,
      columnWidths: {
        "EPC ID": 36,
        "Approver Name": 25,
        "Approver Email": 30,
        Reason: 40,
      },
    },
  ];
}

// ── Public API ────────────────────────────────────────────────────────────────

export type EpcExportResult = {
  s3Key: string;
  filename: string;
  totalEpcs: number;
};

export async function exportEpcsToS3(
  filters: EpcExportFilters,
  format: "csv" | "xlsx",
  onProgress: (processed: number) => void,
): Promise<EpcExportResult> {
  const epcRows: XlsxRow[] = [];
  const lineItemRows: XlsxRow[] = [];
  const workflowRows: XlsxRow[] = [];

  let cursor: string | undefined;
  let totalEpcs = 0;

  // ── Cursor loop ───────────────────────────────────────────────────────────
  while (true) {
    const batch = await fetchEpcBatch(filters, cursor);
    if (batch.length === 0) break;

    const workflowsByEpcId = await fetchWorkflowsForBatch(
      batch.map((epc) => epc.id),
    );

    for (const epc of batch) {
      epcRows.push(extractEpcRow(epc));
      lineItemRows.push(...extractLineItemRows(epc));
      workflowRows.push(
        ...extractWorkflowRows(epc, workflowsByEpcId.get(epc.id) ?? []),
      );
    }

    totalEpcs += batch.length;
    onProgress(totalEpcs);

    // If batch is smaller than BATCH_SIZE we've reached the end
    if (batch.length < BATCH_SIZE) break;

    cursor = batch[batch.length - 1].id;
  }

  // ── Build file buffer ─────────────────────────────────────────────────────
  const timestamp = new Date().toISOString().slice(0, 10);
  let buffer: Buffer;
  let filename: string;

  if (format === "xlsx") {
    buffer = buildXlsxBuffer(
      buildSheetDefinitions(epcRows, lineItemRows, workflowRows),
    );
    filename = `epc-dump-${timestamp}.xlsx`;
  } else {
    // CSV: flatten all three datasets into one file with a Type column
    const csvRows = [
      ...epcRows.map((r) => ({ Sheet: "EPC", ...r })),
      ...lineItemRows.map((r) => ({ Sheet: "LineItem", ...r })),
      ...workflowRows.map((r) => ({ Sheet: "Workflow", ...r })),
    ];
    buffer = rowsToCsvBuffer(csvRows);
    filename = `epc-dump-${timestamp}.csv`;
  }

  // ── Upload to S3 ──────────────────────────────────────────────────────────
  const s3Key = `exports/epc/${filename}`;
  await uploadBufferToS3(s3Key, buffer, filename);

  return { s3Key, filename, totalEpcs };
}
