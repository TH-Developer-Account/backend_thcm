import { Prisma } from "../prisma/generated/prisma/client";
import { prisma } from "../config/prisma";
import { getPeerUserIds } from "../services/orgHierarchy.services";

interface SearchEventProposalInput {
  userId: string;
  approvedByMe?: boolean;
  pendingOnMe?: boolean;
  search?: string;
  status?: string;
  // ✅ FIX 1: departmentId type changed from number → string
  // The schema stores department_id as a UUID string (String @id @default(uuid())).
  // The original `number` type would cause a Postgres type mismatch at runtime.
  departmentId?: string;
  startDate?: Date;
  endDate?: Date;
  page?: number;
  pageSize?: number;
  sortBy?: "created_at" | "proposal_number" | "status";
  sortOrder?: "asc" | "desc";
  // ── Org hierarchy scoping ──────────────────────────────────────────────────
  // createdByIds: own ID + all subordinate IDs from getSubtreeUserIds.
  // When present, replaces the default "created_by_id = userId" filter.
  createdByIds?: string[];
  // scopingFilter: dept/zone restriction from getEpcScopingFilter.
  //   {}                                            HEAD — no extra filter
  //   { department_id: "uuid" }                     DEPT_HEAD
  //   { department_id: "uuid", region_id: "uuid" }  ZONAL/AREA_HEAD
  // Applied to the subordinates slice ONLY — peers bypass this intentionally.
  scopingFilter?: Record<string, string>;
  // p2pEnabled: when true, the helper resolves peer user IDs itself
  // and adds them as a second OR slice with no dept/zone filter.
  // The controller passes the raw boolean from isPeerToPeerEnabled().
  p2pEnabled?: boolean;
}

export async function searchEventProposals(filters: SearchEventProposalInput) {
  const {
    userId,
    approvedByMe,
    pendingOnMe,
    search,
    status,
    departmentId,
    startDate,
    endDate,
    page = 1,
    pageSize = 10,
    sortBy = "created_at",
    sortOrder = "desc",
    createdByIds,
    scopingFilter,
    p2pEnabled,
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
    conditions.push(Prisma.sql`ep.status = ${status}`);
  }

  if (departmentId) {
    conditions.push(Prisma.sql`ep.department_id = ${departmentId}`);
  }

  if (startDate) {
    conditions.push(Prisma.sql`ep.created_at >= ${startDate}`);
  }

  if (endDate) {
    conditions.push(Prisma.sql`ep.created_at <= ${endDate}`);
  }

  // ============================================================
  // 🎯 USER-BASED FILTERING — three modes
  // ============================================================

  if (userId) {
    // ─────────────────────────────────────────────────────────
    // MODE 1: pendingOnMe
    //
    // Show EPCs where the current user has a PENDING approval
    // waiting for their action RIGHT NOW.
    //
    // Three new conditions vs original:
    //
    //   ✅ FIX 2a: wf."isActive" = true
    //      Without this, the query would match approvals on SUPERSEDED
    //      workflows (ones replaced by a Deviation). Those approvals are
    //      read-only historical records — they should never surface as
    //      "pending on me".
    //
    //   ✅ FIX 2b: si."isCurrentIteration" = true
    //      Without this, old clarify-iteration stages (isCurrentIteration=false)
    //      would match. An approver who was assigned in iteration 1 but got
    //      bypassed by a CLARIFY should NOT see their old approval as pending.
    //
    //   ✅ FIX 2c: si.status = 'IN_PROGRESS' (was 'PENDING')
    //      Stage status is 'IN_PROGRESS' while it is actively awaiting
    //      approvals. 'PENDING' means the stage hasn't started yet (it's
    //      waiting for the previous stage to finish). Matching 'PENDING'
    //      stages would never return results for the *current* stage.
    // ─────────────────────────────────────────────────────────
    if (pendingOnMe) {
      conditions.push(
        Prisma.sql`
          EXISTS (
            SELECT 1
            FROM "WorkflowInstance" wf
            JOIN "StageInstance" si
              ON wf.id = si."workflowId"
            JOIN "Approval" ap
              ON si.id = ap."stageId"
            WHERE wf."eventProposalId" = ep.id
              AND wf."isActive" = true
              AND si."isCurrentIteration" = true
              AND si.status = 'IN_PROGRESS'
              AND ap."approverId" = ${userId}
              AND ap.status = 'PENDING'
          )
        `,
      );
    }

    // ─────────────────────────────────────────────────────────
    // MODE 2: approvedByMe
    //
    // Show EPCs where the current user has approved at any point
    // in the ACTIVE workflow's history (any iteration).
    //
    //   ✅ FIX 3a: wf."isActive" = true
    //      We scope to the active workflow only, so superseded workflows
    //      from past Deviations don't pollute this list. If the old
    //      workflow was replaced, its approvals belong to history.
    //
    //   NOTE: No isCurrentIteration filter here — intentional.
    //      If the user approved in iteration 1 and then someone triggered
    //      a CLARIFY (creating iteration 2), the user's iteration-1 approval
    //      is still a real approval that happened. They should still see
    //      the EPC in their "approved by me" list as historical participation.
    // ─────────────────────────────────────────────────────────
    else if (approvedByMe) {
      conditions.push(
        Prisma.sql`
          EXISTS (
            SELECT 1
            FROM "WorkflowInstance" wf
            JOIN "StageInstance" si
              ON wf.id = si."workflowId"
            JOIN "Approval" ap
              ON si.id = ap."stageId"
            WHERE wf."eventProposalId" = ep.id
              AND wf."isActive" = true
              AND ap."approverId" = ${userId}
              AND ap.status = 'APPROVED'
          )
        `,
      );
    }

    // ─────────────────────────────────────────────────────────
    // MODE 3: default visibility — org hierarchy + peer-to-peer
    //
    // When createdByIds is provided the user is under org hierarchy
    // scoping. Visibility is built as two OR slices:
    //
    //   Slice A — subordinates (with dept/zone filter from scopingFilter):
    //     ep.created_by_id IN (createdByIds)
    //     AND ep.department_id = <dept>   ← only if scopingFilter has it
    //     AND ep.region_id    = <zone>    ← only if scopingFilter has it
    //
    //   Slice B — peers (p2pEnabled = true only):
    //     ep.created_by_id IN (peerUserIds)
    //     ← NO dept/zone filter — zone is intentionally relaxed for peers.
    //        e.g. Marketing Zonal Head South can see Marketing Zonal Head
    //        North's EPCs without zone restriction.
    //     peerUserIds is resolved here by calling getPeerUserIds(userId).
    //     getPeerUserIds returns [] for HEAD and MEMBER designations so
    //     no extra guard is needed.
    //
    // When createdByIds is NOT provided (no org tree configured), falls
    // back to the original "created by me only" behaviour unchanged.
    // ─────────────────────────────────────────────────────────
    else {
      if (createdByIds && createdByIds.length > 0) {
        // ── Slice A: subordinates + scoping filter ────────────────────────

        // Translate the plain scopingFilter object into SQL conditions.
        // scopingFilter is one of:
        //   {}                               → no extra SQL (HEAD level)
        //   { department_id }                → one condition
        //   { department_id, region_id }     → two conditions
        const scopingConditions: Prisma.Sql[] = [];

        if (scopingFilter?.department_id) {
          scopingConditions.push(
            Prisma.sql`ep.department_id = ${scopingFilter.department_id}`,
          );
        }
        if (scopingFilter?.region_id) {
          scopingConditions.push(
            Prisma.sql`ep.region_id = ${scopingFilter.region_id}`,
          );
        }

        // ANY($1::text[]) — created_by_id is stored as text in Postgres
        // (Prisma String → text). Casting to uuid[] causes operator mismatch.
        const subtreeSlice =
          scopingConditions.length > 0
            ? Prisma.sql`(
                ep.created_by_id = ANY(${createdByIds}::text[])
                AND ${Prisma.join(scopingConditions, " AND ")}
              )`
            : Prisma.sql`ep.created_by_id = ANY(${createdByIds}::text[])`;

        // ── Slice B: peers (no zone filter) ──────────────────────────────
        // Only resolved when p2pEnabled is true.
        // getPeerUserIds returns [] for HEAD (already sees all) and MEMBER
        // (excluded from P2P) so the result is always safe to use directly.
        let peerSlice: Prisma.Sql | null = null;

        if (p2pEnabled) {
          const peerUserIds = await getPeerUserIds(userId);
          if (peerUserIds.length > 0) {
            peerSlice = Prisma.sql`ep.created_by_id = ANY(${peerUserIds}::text[])`;
          }
        }

        // ── Combine slices with OR ────────────────────────────────────────
        // The outer parentheses are critical — without them the OR would
        // bind loosely against the surrounding AND conditions (status,
        // search, dates) and return incorrect results.
        if (peerSlice) {
          conditions.push(Prisma.sql`(${subtreeSlice} OR ${peerSlice})`);
        } else {
          conditions.push(subtreeSlice);
        }
      } else {
        // ── No org hierarchy configured — original "created by me" ────────
        conditions.push(Prisma.sql`ep.created_by_id = ${userId}`);
      }
    }
  }

  // ============================================================

  const whereClause =
    conditions.length > 0
      ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`
      : Prisma.empty;

  const direction = sortOrder === "desc" ? Prisma.sql`DESC` : Prisma.sql`ASC`;

  let orderByClause: Prisma.Sql;

  if (search) {
    orderByClause = Prisma.sql`
      ORDER BY
        ts_rank(ep.search_vector, plainto_tsquery('english', ${search})) DESC,
        ${Prisma.raw(`ep."${sortBy}"`)} ${direction}
    `;
  } else {
    orderByClause = Prisma.sql`
      ORDER BY ${Prisma.raw(`ep."${sortBy}"`)} ${direction}
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
