import { Prisma } from "../prisma/generated/prisma/client";
import { prisma } from "../config/prisma";

interface SearchEventProposalInput {
  userId: string;
  approvedByMe?: boolean;
  pendingOnMe?: boolean;
  pendingReportValidation?: boolean;
  reportValidatedByMe?: boolean;
  search?: string;
  status?: string[];
  departmentId?: string;
  startDate?: Date;
  endDate?: Date;
  page?: number;
  pageSize?: number;
  sortBy?: "created_at" | "proposal_number" | "status" | "event_name";
  sortOrder?: "asc" | "desc";
  zone?: string[];
  eventType?: string[];
  createdDate?: Date;
}

// Maps each valid sortBy key to its actual SQL expression.
//
// Why a map instead of string interpolation:
//   1. Some sort columns are JOIN aliases (e.g. event_name lives on `en.title`,
//      not on `ep`), so prefixing blindly with `ep.` would produce invalid SQL.
//   2. Eliminates SQL injection risk from user-controlled sortBy values —
//      unknown keys fall back to the default safely.
const SORT_COLUMN_MAP: Record<
  NonNullable<SearchEventProposalInput["sortBy"]>,
  Prisma.Sql
> = {
  created_at: Prisma.sql`ep.created_at`,
  proposal_number: Prisma.sql`ep.proposal_number`,
  status: Prisma.sql`ep.status`,
  event_name: Prisma.sql`en.title`,
};

export async function searchEventProposals(filters: SearchEventProposalInput) {
  const {
    userId,
    approvedByMe,
    pendingOnMe,
    pendingReportValidation,
    reportValidatedByMe,
    search = "",
    status,
    departmentId,
    startDate,
    endDate,
    page = 1,
    pageSize = 10,
    sortBy = "created_at",
    sortOrder = "desc",
    zone,
    eventType,
    createdDate,
  } = filters;

  const skip = (page - 1) * pageSize;

  const conditions: Prisma.Sql[] = [];

  // 🔎 Full-text search
  if (search) {
    conditions.push(
      Prisma.sql`ep.search_vector @@ plainto_tsquery('english', ${search})`,
    );
  }

  // 📌 Basic filters — all prefixed with `ep.` to avoid ambiguity with JOINs
  if (status) {
    conditions.push(Prisma.sql`ep.status IN (${Prisma.join(status)})`);
  }

  if (departmentId) {
    conditions.push(Prisma.sql`ep.department_id = ${departmentId}`);
  }

  if (startDate) {
    conditions.push(Prisma.sql`ep.event_from_date >= ${startDate}`);
  }

  if (endDate) {
    conditions.push(Prisma.sql`ep.event_to_date <= ${endDate}`);
  }

  if (createdDate) {
    conditions.push(Prisma.sql`DATE(ep.created_at) = ${createdDate}`);
  }

  if (zone) {
    conditions.push(Prisma.sql`ep.region_id IN (${Prisma.join(zone)})`);
  }

  if (eventType?.length) {
    conditions.push(
      Prisma.sql`ep.event_name_id IN (${Prisma.join(eventType)})`,
    );
  }

  // ============================================================
  // 🎯 USER-BASED FILTERING
  //
  // Two combined modes using OR logic:
  //
  //   pendingOnMe + pendingValidation    → workflow pending OR report pending
  //   approvedByMe + reportValidatedByMe → workflow approved OR report validated
  //
  // Both flags can be passed simultaneously so a user who is both
  // an approver and a validator sees everything relevant in one list.
  // ============================================================

  if (userId) {
    if (pendingOnMe) {
      const subConditions: Prisma.Sql[] = [];

      // ─────────────────────────────────────────────────────────
      // PENDING WORKFLOW APPROVAL
      // User has a PENDING approval on the active workflow's
      // current iteration stage right now.
      // ─────────────────────────────────────────────────────────
      subConditions.push(
        Prisma.sql`
            EXISTS (
              SELECT 1
              FROM "WorkflowInstance" wf
              JOIN "StageInstance" si ON wf.id = si."workflowId"
              JOIN "Approval" ap ON si.id = ap."stageId"
              WHERE wf."eventProposalId" = ep.id
                AND wf."isActive" = true
                AND si."isCurrentIteration" = true
                AND si.status = 'IN_PROGRESS'
                AND ap."approverId" = ${userId}
                AND ap.status = 'PENDING'
            )
          `,
      );

      // ─────────────────────────────────────────────────────────
      // PENDING REPORT VALIDATION
      // User is the validator and the report is awaiting review.
      // ─────────────────────────────────────────────────────────
      if (pendingReportValidation) {
        subConditions.push(
          Prisma.sql`
            EXISTS (
              SELECT 1
              FROM "EventReport" er
              WHERE er."epcId" = ep.id
                AND er."validatorId" = ${userId}
                AND er.status = 'SUBMITTED'
            )
          `,
        );
      }

      conditions.push(Prisma.sql`(${Prisma.join(subConditions, " OR ")})`);
    } else if (approvedByMe) {
      const subConditions: Prisma.Sql[] = [];

      // ─────────────────────────────────────────────────────────
      // APPROVED IN WORKFLOW
      // User has approved at any point in the active workflow's
      // history (any iteration). No isCurrentIteration filter —
      // intentional, past approvals are still real history.
      // ─────────────────────────────────────────────────────────
      subConditions.push(
        Prisma.sql`
            EXISTS (
              SELECT 1
              FROM "WorkflowInstance" wf
              JOIN "StageInstance" si ON wf.id = si."workflowId"
              JOIN "Approval" ap ON si.id = ap."stageId"
              WHERE wf."eventProposalId" = ep.id
                AND wf."isActive" = true
                AND ap."approverId" = ${userId}
                AND ap.status = 'APPROVED'
            )
          `,
      );

      // ─────────────────────────────────────────────────────────
      // REPORT VALIDATED
      // User has validated the report.
      // CLARIFICATION_REQUESTED intentionally excluded — those
      // are still in-flight and belong in pendingValidation.
      // ─────────────────────────────────────────────────────────
      if (reportValidatedByMe) {
        subConditions.push(
          Prisma.sql`
            EXISTS (
              SELECT 1
              FROM "EventReport" er
              WHERE er."epcId" = ep.id
                AND er."validatorId" = ${userId}
                AND er.status = 'VALIDATED'
            )
          `,
        );
      }

      conditions.push(Prisma.sql`(${Prisma.join(subConditions, " OR ")})`);
    }

    // ─────────────────────────────────────────────────────────
    // DEFAULT — created by me
    // ─────────────────────────────────────────────────────────
    else {
      conditions.push(Prisma.sql`ep.created_by_id = ${userId}`);
    }
  }

  // ============================================================

  const whereClause =
    conditions.length > 0
      ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`
      : Prisma.empty;

  const direction = sortOrder === "desc" ? Prisma.sql`DESC` : Prisma.sql`ASC`;

  // Resolve the sort column from the whitelist; fall back to created_at if
  // an unrecognised key somehow slips through (e.g. future refactor drift).
  const sortColumn = SORT_COLUMN_MAP[sortBy] ?? Prisma.sql`ep.created_at`;

  let orderByClause: Prisma.Sql;

  if (search) {
    orderByClause = Prisma.sql`
      ORDER BY
        ts_rank(ep.search_vector, plainto_tsquery('english', ${search})) DESC,
        ${sortColumn} ${direction}
    `;
  } else {
    orderByClause = Prisma.sql`
      ORDER BY ${sortColumn} ${direction}
    `;
  }

  const ranking = search
    ? Prisma.sql`ts_rank(ep.search_vector, plainto_tsquery('english', ${search}))`
    : Prisma.sql`NULL`;

  /* ─────────────────────────────────────────────────────────────
   * DATA QUERY
   *
   * ✅ FIX 4: WorkflowInstance JOIN now filters to isActive = true
   *
   * Original:
   *   LEFT JOIN "WorkflowInstance" wf ON ep.id = wf."eventProposalId"
   *
   * Problem: an EPC can now have multiple WorkflowInstances over time
   * (STANDARD + one or more DEVIATION workflows). Without the isActive
   * filter, a single EPC would appear as multiple rows in the result —
   * one per workflow. The list page would show duplicates.
   *
   * Fix: join only the active workflow. Each EPC now appears at most once.
   *
   * ✅ NEW columns added to SELECT:
   *   wf.status          AS workflow_status     — APPROVED / IN_PROGRESS / etc.
   *   wf."workflowType"  AS workflow_type       — STANDARD or DEVIATION
   *   wf.iteration       AS workflow_iteration  — which clarify-run we're on
   *   wf."currentStage"  AS workflow_current_stage
   *   wf."isActive"      AS workflow_is_active  — always true here, but useful
   *                                               for client-side type narrowing
   * ───────────────────────────────────────────────────────────── */
  const dataPromise = prisma.$queryRaw<any[]>(Prisma.sql`
    SELECT
      ep.id,
      ep.proposal_number,
      ep.event_from_date,
      ep.event_to_date,
      ep.event_description,
      ep.location,
      ep.event_objective,
      ep.status,
      ep.created_by_id,
      ep.created_at,
      ep.department_id,
      ep.event_name_id,
      en.title                  AS event_name,
      us.first_name             AS first_name,
      us.last_name              AS last_name,
      epf.id                    AS epf_id,
      crf.id                    AS crf_id,
      wf.id                     AS workflow_id,
      -- wf.status                 AS workflow_status,
      -- wf."workflowType"         AS workflow_type,
      -- wf.iteration              AS workflow_iteration,
      -- wf."currentStage"         AS workflow_current_stage,
      -- wf."isActive"             AS workflow_is_active,
      ${ranking}                AS rank
    FROM "EventProposal" ep
    LEFT JOIN "EventName" en
      ON ep.event_name_id = en.id
    LEFT JOIN "Department" d
      ON ep.department_id = d.id
    LEFT JOIN "User" us
      ON ep.created_by_id = us.id
    LEFT JOIN "EPF" epf
      ON ep.id = epf."epcId"
    LEFT JOIN "CRF" crf
      ON ep.id = crf."epcId"
    LEFT JOIN "WorkflowInstance" wf
      ON ep.id = wf."eventProposalId"
      AND wf."isActive" = true
    ${whereClause}
    ${orderByClause}
    LIMIT ${pageSize}
    OFFSET ${skip}
  `);

  /* ─────────────────────────────────────────────────────────────
   * COUNT QUERY
   *
   * ✅ FIX 5: Added `ep` alias to the EventProposal table.
   *
   * Original:
   *   SELECT COUNT(*)::int as total FROM "EventProposal" ${whereClause}
   *
   * Problem: the whereClause conditions built above all reference the
   * table via the `ep` alias (e.g. `ep.created_by_id = $1`, `ep.id`
   * inside the EXISTS subqueries). When the alias is missing, Postgres
   * throws: `column "ep.created_by_id" does not exist`.
   *
   * Fix: alias the table as `ep` here too so both queries share the
   * same WHERE clause without modification.
   *
   * The LEFT JOINs from the data query are intentionally omitted here —
   * the count only needs EventProposal rows, and adding joins would
   * require DISTINCT or GROUP BY to avoid inflating the count.
   * ───────────────────────────────────────────────────────────── */
  const countPromise = prisma.$queryRaw<{ total: number }[]>(Prisma.sql`
    SELECT COUNT(*)::int AS total
    FROM "EventProposal" ep
    ${whereClause}
  `);

  const [data, countResult] = await Promise.all([dataPromise, countPromise]);

  return {
    data,
    total: countResult[0]?.total ?? 0,
  };
}
