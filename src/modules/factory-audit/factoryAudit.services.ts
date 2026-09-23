import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import {
  AuditorRole,
  PartCategory,
  Prisma,
} from "../../prisma/generated/prisma/client";
// Confirmed against workflow.service.ts's real import — plural
// "@notifications", not "@notification" as this file guessed earlier.
import { notify } from "@notifications/notification.services";
import { getOrGeneratePdfUrl } from "@pdf/pdf.services";
import {
  assignWorkflow,
  notifyStageApprovers,
} from "@workflow/workflow.service";
import { computeFactoryAuditClassification } from "./factoryAudit.helper";

// ─────────────────────────────────────────────
// Templates
//
// Same DRAFT → PUBLISHED lifecycle as Dealer Audit's ChecklistTemplate
// (dealerAudit.service.ts) — edit only while DRAFT, version by cloning to a
// new DRAFT, publish deactivates sibling templates. One level deeper here:
// FactoryAuditTemplate → Section → Checkpoint, vs Dealer's flat
// Template → Item. Cascading deletes on Section→Checkpoint (already on the
// schema) are what make "delete-and-recreate while DRAFT" safe without any
// extra cleanup code, same trick as the Dealer side.
// ─────────────────────────────────────────────

// One description per score level (4 = best, 0 = worst), keyed by level as
// a string — {"4": "...", ..., "0": "..."}. A plain Record, not a branded
// type, but assertValidCriteria (below) is what actually guarantees the
// five keys are present before this ever reaches Prisma — TS alone can't
// enforce "exactly these five keys" on a Record<string, string>.
type CriteriaByLevel = Record<string, string>;

type CheckpointInput = {
  order: number;
  label: string;
  checkPoint: string;
  weight: number;
  requiresEvidence?: boolean;
  criteria: CriteriaByLevel;
};

type SectionInput = {
  order: number;
  name: string;
  passThreshold: number;
  elevatedPassThresholdForCriticalParts?: number;
  checkpoints: CheckpointInput[];
};

const EXPECTED_CRITERIA_LEVELS = ["0", "1", "2", "3", "4"];

// Every checkpoint on every checksheet inspected has exactly five level
// descriptions (0–4) — confirmed against the real Sheetmetal/Forging/etc.
// sheets, where each checkpoint row carries columns for 4,3,2,1,0. Unlike
// the five-fixed-fields version of this model, a JSON column has no
// DB-level or TS-level guarantee the right keys are present, so this check
// is what actually enforces it now — at template-write time, not left to
// surface later as a missing description mid-audit.
function assertValidCriteria(
  checkpointLabel: string,
  criteria: CriteriaByLevel,
) {
  const keys = Object.keys(criteria ?? {}).sort();
  const isValid =
    keys.length === EXPECTED_CRITERIA_LEVELS.length &&
    keys.every((key, i) => key === EXPECTED_CRITERIA_LEVELS[i]) &&
    keys.every(
      (key) =>
        typeof criteria[key] === "string" && criteria[key].trim().length > 0,
    );
  if (!isValid) {
    throw new ApiError(
      400,
      `Checkpoint "${checkpointLabel}" must have criteria for exactly levels 0–4, got [${keys.join(", ")}]`,
    );
  }
}

function assertValidSections(sections: SectionInput[]) {
  if (!sections?.length) {
    throw new ApiError(400, "At least one section is required");
  }
  for (const section of sections) {
    if (!section.checkpoints?.length) {
      throw new ApiError(
        400,
        `Section "${section.name}" needs at least one checkpoint`,
      );
    }
    for (const checkpoint of section.checkpoints) {
      assertValidCriteria(checkpoint.label, checkpoint.criteria);
    }
  }
}

// Nested-create shape shared by createFactoryAuditTemplate and
// createFactoryAuditTemplateDraftVersion — the only difference between
// "create fresh" and "clone from a source template" is where the section
// data comes from, not how it's assembled into a Prisma nested-write.
function buildSectionsCreateInput(sections: SectionInput[]) {
  return sections.map((section) => ({
    order: section.order,
    name: section.name,
    passThreshold: section.passThreshold,
    elevatedPassThresholdForCriticalParts:
      section.elevatedPassThresholdForCriticalParts ?? undefined,
    checkpoints: {
      create: section.checkpoints.map((checkpoint) => ({
        order: checkpoint.order,
        label: checkpoint.label,
        checkPoint: checkpoint.checkPoint,
        weight: checkpoint.weight,
        requiresEvidence: checkpoint.requiresEvidence ?? true,
        criteria: checkpoint.criteria as Prisma.InputJsonValue,
      })),
    },
  }));
}

const TEMPLATE_TREE_INCLUDE = {
  sections: {
    orderBy: { order: "asc" as const },
    include: {
      checkpoints: { orderBy: { order: "asc" as const } },
    },
  },
};

export async function createFactoryAuditTemplate(data: {
  processCategory: string;
  name: string;
  sections: SectionInput[];
}) {
  assertValidSections(data.sections);

  return prisma.factoryAuditTemplate.create({
    data: {
      processCategory: data.processCategory,
      name: data.name,
      version: 1,
      status: "DRAFT",
      isActive: false, // a draft is never the active template for new audits
      sections: { create: buildSectionsCreateInput(data.sections) },
    },
    include: TEMPLATE_TREE_INCLUDE,
  });
}

export async function listFactoryAuditTemplates(filters: {
  processCategory?: string;
  isActive?: boolean;
}) {
  return prisma.factoryAuditTemplate.findMany({
    where: {
      processCategory: filters.processCategory,
      isActive: filters.isActive,
    },
    orderBy: [{ processCategory: "asc" }, { version: "desc" }],
  });
}

export async function getFactoryAuditTemplateById(id: string) {
  const template = await prisma.factoryAuditTemplate.findUnique({
    where: { id },
    include: TEMPLATE_TREE_INCLUDE,
  });
  if (!template) throw new ApiError(404, "Template not found");
  return template;
}

export async function updateFactoryAuditTemplateDraft(
  id: string,
  data: { name?: string; sections?: SectionInput[] },
) {
  const template = await prisma.factoryAuditTemplate.findUnique({
    where: { id },
  });
  if (!template) throw new ApiError(404, "Template not found");
  if (template.status !== "DRAFT") {
    throw new ApiError(
      400,
      "Only a draft template can be edited — publish a new draft version instead",
    );
  }
  if (data.sections) {
    assertValidSections(data.sections);
  }

  return prisma.$transaction(async (tx) => {
    if (data.sections) {
      // Safe to delete-and-recreate wholesale, specifically because this
      // template is still DRAFT: nothing has snapshotted it yet (only a
      // PUBLISHED template is ever referenced by FactoryAuditInstance), so
      // there's no risk of orphaning a real audit's responses. Deleting the
      // sections cascades away their checkpoints too — no separate cleanup
      // needed for those.
      await tx.factoryAuditSection.deleteMany({ where: { templateId: id } });
      await tx.factoryAuditTemplate.update({
        where: { id },
        data: { sections: { create: buildSectionsCreateInput(data.sections) } },
      });
    }

    return tx.factoryAuditTemplate.update({
      where: { id },
      data: { name: data.name },
      include: TEMPLATE_TREE_INCLUDE,
    });
  });
}

export async function createFactoryAuditTemplateDraftVersion(id: string) {
  const source = await prisma.factoryAuditTemplate.findUnique({
    where: { id },
    include: TEMPLATE_TREE_INCLUDE,
  });
  if (!source) throw new ApiError(404, "Template not found");
  if (source.status !== "PUBLISHED") {
    throw new ApiError(
      400,
      "A new draft version can only be created from a published template",
    );
  }

  const sectionsInput: SectionInput[] = source.sections.map((section) => ({
    order: section.order,
    name: section.name,
    passThreshold: section.passThreshold,
    elevatedPassThresholdForCriticalParts:
      section.elevatedPassThresholdForCriticalParts ?? undefined,
    checkpoints: section.checkpoints.map((checkpoint) => ({
      order: checkpoint.order,
      label: checkpoint.label,
      checkPoint: checkpoint.checkPoint,
      weight: checkpoint.weight,
      requiresEvidence: checkpoint.requiresEvidence,
      // checkpoint.criteria comes back from Prisma typed as Prisma.JsonValue
      // (the DB doesn't know it's shaped like CriteriaByLevel) — safe to
      // assert here since it was only ever written by buildSectionsCreateInput
      // after passing assertValidCriteria in the first place.
      criteria: checkpoint.criteria as CriteriaByLevel,
    })),
  }));

  return prisma.factoryAuditTemplate.create({
    data: {
      processCategory: source.processCategory,
      name: source.name,
      version: source.version + 1,
      status: "DRAFT",
      isActive: false,
      sections: { create: buildSectionsCreateInput(sectionsInput) },
    },
    include: TEMPLATE_TREE_INCLUDE,
  });
}

export async function publishFactoryAuditTemplate(id: string) {
  const template = await prisma.factoryAuditTemplate.findUnique({
    where: { id },
  });
  if (!template) throw new ApiError(404, "Template not found");
  if (template.status !== "DRAFT") {
    throw new ApiError(400, "Only a draft template can be published");
  }

  return prisma.$transaction(async (tx) => {
    // processCategory is the versioning axis here (@@unique([processCategory,
    // version])), same role name/officeType plays for ChecklistTemplate.
    await tx.factoryAuditTemplate.updateMany({
      where: {
        processCategory: template.processCategory,
        isActive: true,
        id: { not: id },
      },
      data: { isActive: false },
    });

    return tx.factoryAuditTemplate.update({
      where: { id },
      data: { status: "PUBLISHED", isActive: true },
      include: TEMPLATE_TREE_INCLUDE,
    });
  });
}

// ─────────────────────────────────────────────
// Instance + assignment creation
//
// Schedules a new Factory Audit as a root FactoryAuditInstance
// (type: INITIAL, parentId: null) with its AuditAssignment rows attached —
// one nested Prisma create, so there's no window where an instance exists
// with no assignments yet.
//
// No per-assignment checkpoint list any more: confirmed every assigned
// auditor scores every checkpoint in scope (no division of labor by role),
// so "which checkpoints does auditor X cover" isn't a question that needs
// answering per assignment — scope lives once, on the instance
// (scopedCheckpointIds), shared by every assignment under it. For an
// INITIAL instance that field is left empty, meaning "every checkpoint in
// the template" (see FactoryAuditInstance's own schema comment) — nothing
// to populate here at creation time.
// ─────────────────────────────────────────────

type AssignmentInput = {
  auditorId: string;
  role: AuditorRole;
};

async function resolvePublishedTemplateForVendor(vendorId: string) {
  const vendor = await prisma.supplier.findUnique({
    where: { id: vendorId },
    select: { id: true, isActive: true, processCategory: true },
  });
  if (!vendor) throw new ApiError(404, "Vendor not found");
  if (!vendor.isActive) throw new ApiError(400, "This vendor is not active");

  const template = await prisma.factoryAuditTemplate.findFirst({
    where: {
      processCategory: vendor.processCategory,
      isActive: true,
      status: "PUBLISHED",
    },
    include: TEMPLATE_TREE_INCLUDE,
  });
  if (!template) {
    throw new ApiError(
      400,
      `No published, active template found for process category "${vendor.processCategory}"`,
    );
  }
  return template;
}

export async function scheduleFactoryAuditInstance(data: {
  vendorId: string;
  workspaceId: string;
  createdByUserId: string;
  targetPartCategories: PartCategory[];
  assignments: AssignmentInput[];
}) {
  if (!data.assignments?.length) {
    throw new ApiError(400, "At least one auditor assignment is required");
  }

  // AuditAssignment's unique key is [auditInstanceId, auditorId] — one row
  // per auditor per instance. Two entries for the same auditor here would
  // hit a DB constraint violation instead of a clear error, so caught
  // earlier.
  const auditorIds = data.assignments.map((a) => a.auditorId);
  const duplicateAuditorId = auditorIds.find(
    (id, i) => auditorIds.indexOf(id) !== i,
  );
  if (duplicateAuditorId) {
    throw new ApiError(
      400,
      `Auditor ${duplicateAuditorId} is assigned more than once — each auditor should appear in at most one assignment entry`,
    );
  }

  const template = await resolvePublishedTemplateForVendor(data.vendorId);

  return prisma.factoryAuditInstance.create({
    data: {
      type: "INITIAL",
      vendorId: data.vendorId,
      workspaceId: data.workspaceId,
      templateId: template.id,
      createdByUserId: data.createdByUserId,
      targetPartCategories: data.targetPartCategories,
      assignments: {
        create: data.assignments.map((a) => ({
          auditorId: a.auditorId,
          role: a.role,
        })),
      },
    },
    include: {
      assignments: {
        include: { auditor: { select: { first_name: true, last_name: true } } },
      },
    },
  });
}

// Root audits only by default (parentId: null) — a REOPEN/SUB_AUDIT round is
// viewed by drilling into its parent (getFactoryAuditInstanceById includes
// `children`), not surfaced alongside root audits in the main list.
export async function listFactoryAuditInstances(filters: {
  vendorId?: string;
}) {
  return prisma.factoryAuditInstance.findMany({
    where: { vendorId: filters.vendorId, parentId: null },
    include: {
      vendor: { select: { name: true, code: true, processCategory: true } },
      template: {
        select: { name: true, processCategory: true, version: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function getFactoryAuditInstanceById(id: string) {
  const instance = await prisma.factoryAuditInstance.findUnique({
    where: { id },
    include: {
      vendor: true,
      template: true,
      children: { orderBy: { createdAt: "asc" } },
      assignments: {
        include: {
          auditor: { select: { first_name: true, last_name: true } },
          responses: true,
        },
      },
      results: true,
    },
  });
  if (!instance) throw new ApiError(404, "Audit instance not found");
  return instance;
}

// Every checkpoint id in play for this instance's round — the specific
// subset for a REOPEN/SUB_AUDIT (scopedCheckpointIds populated), or every
// checkpoint under the snapshotted template for an INITIAL instance
// (scopedCheckpointIds empty, per its own schema comment).
async function resolveInstanceCheckpointScope(
  instanceId: string,
): Promise<string[]> {
  const instance = await prisma.factoryAuditInstance.findUnique({
    where: { id: instanceId },
    select: { scopedCheckpointIds: true, templateId: true },
  });
  if (!instance) throw new ApiError(404, "Audit instance not found");
  if (instance.scopedCheckpointIds.length) return instance.scopedCheckpointIds;

  const template = await prisma.factoryAuditTemplate.findUnique({
    where: { id: instance.templateId },
    include: TEMPLATE_TREE_INCLUDE,
  });
  if (!template) throw new ApiError(404, "Template not found");
  return template.sections.flatMap((s) => s.checkpoints.map((c) => c.id));
}

// ─────────────────────────────────────────────
// Auditor scoring
//
// Two-phase submission per assignment, matching the checksheet's real
// workflow (confirmed): a draft phase where an auditor freely saves/edits
// their own scores (FactoryAuditResponse.iteration 1, upserted in place),
// then Submit locks that in. Once every assignment on the instance has
// submitted, a revision window opens — one more edit per checkpoint,
// written as iteration 2 — closed by a Reviewer's explicit finalize, which
// computes AuditCheckpointResult from whichever iteration is current per
// (assignment, checkpoint).
//
// Deliberately no stored "all submitted" / "finalized" flags on the
// instance — both are derived (see resolveAssignmentSubmissionState and
// isFactoryAuditRoundFinalized below) rather than duplicating state that's
// already fully determined by AuditAssignment.status and whether
// AuditCheckpointResult rows exist. Keeping the schema exactly as finalized.
// ─────────────────────────────────────────────

type CheckpointScoreInput = {
  checkpointId: string;
  score?: number | null; // 0–4
  isNotApplicable?: boolean;
  remark?: string;
};

async function getOwnAssignmentOrThrow(
  assignmentId: string,
  auditorUserId: string,
) {
  const assignment = await prisma.auditAssignment.findUnique({
    where: { id: assignmentId },
  });
  if (!assignment) throw new ApiError(404, "Assignment not found");
  if (assignment.auditorId !== auditorUserId) {
    throw new ApiError(403, "This assignment does not belong to you");
  }
  return assignment;
}

function assertCheckpointsInScope(checkpointIds: string[], scope: string[]) {
  const scopeSet = new Set(scope);
  const outOfScope = checkpointIds.filter((id) => !scopeSet.has(id));
  if (outOfScope.length) {
    throw new ApiError(
      400,
      `Checkpoint(s) not in this audit's scope: ${outOfScope.join(", ")}`,
    );
  }
}

// Draft save — free to call repeatedly while the assignment is still
// ASSIGNED. Upserts at iteration 1; never creates a second row here (that's
// reviseFactoryAuditCheckpointScore's job, and only after submission).
export async function saveFactoryAuditCheckpointScores(
  auditorUserId: string,
  assignmentId: string,
  scores: CheckpointScoreInput[],
) {
  const assignment = await getOwnAssignmentOrThrow(assignmentId, auditorUserId);
  if (assignment.status !== "ASSIGNED") {
    throw new ApiError(
      400,
      "Scores can only be saved before this assignment is submitted",
    );
  }

  const scope = await resolveInstanceCheckpointScope(
    assignment.auditInstanceId,
  );
  assertCheckpointsInScope(
    scores.map((s) => s.checkpointId),
    scope,
  );

  return prisma.$transaction(
    scores.map((s) =>
      prisma.factoryAuditResponse.upsert({
        where: {
          assignmentId_checkpointId_iteration: {
            assignmentId,
            checkpointId: s.checkpointId,
            iteration: 1,
          },
        },
        create: {
          assignmentId,
          checkpointId: s.checkpointId,
          iteration: 1,
          score: s.score ?? null,
          isNotApplicable: s.isNotApplicable ?? false,
          remark: s.remark,
        },
        update: {
          score: s.score ?? null,
          isNotApplicable: s.isNotApplicable ?? false,
          remark: s.remark,
        },
      }),
    ),
  );
}

// A checkpoint counts as "scored" once it has a score or is explicitly
// marked N/A — an empty draft row (neither) doesn't satisfy the checklist,
// same convention as score being nullable everywhere else in this model.
function isCheckpointScored(response: {
  score: number | null;
  isNotApplicable: boolean;
}) {
  return response.isNotApplicable || response.score != null;
}

export async function submitFactoryAuditAssignment(
  auditorUserId: string,
  assignmentId: string,
) {
  const assignment = await getOwnAssignmentOrThrow(assignmentId, auditorUserId);
  if (assignment.status !== "ASSIGNED") {
    throw new ApiError(400, "This assignment has already been submitted");
  }

  const scope = await resolveInstanceCheckpointScope(
    assignment.auditInstanceId,
  );
  const responses = await prisma.factoryAuditResponse.findMany({
    where: { assignmentId, iteration: 1, checkpointId: { in: scope } },
  });
  const scoredCheckpointIds = new Set(
    responses.filter(isCheckpointScored).map((r) => r.checkpointId),
  );
  const missing = scope.filter((id) => !scoredCheckpointIds.has(id));
  if (missing.length) {
    throw new ApiError(
      400,
      `${missing.length} of ${scope.length} checkpoint(s) still need a score or N/A before submitting`,
    );
  }

  await prisma.auditAssignment.update({
    where: { id: assignmentId },
    data: { status: "SUBMITTED" },
  });

  // If this was the last outstanding assignment, the revision window just
  // opened for everyone on this round. Surfaced as a return value, not
  // fired from inside this function — submitFactoryAuditAssignment stays
  // about the one assignment's state change; notifyFactoryAuditAllSubmitted
  // (below) is a separate, explicitly-called step for the "tell everyone"
  // side effect, so the two responsibilities stay independently testable
  // and callable rather than one function silently doing both.
  const remainingUnsubmitted = await prisma.auditAssignment.count({
    where: { auditInstanceId: assignment.auditInstanceId, status: "ASSIGNED" },
  });

  return {
    assignmentId,
    auditInstanceId: assignment.auditInstanceId,
    allSubmitted: remainingUnsubmitted === 0,
  };
}

// Fired once, right after submitFactoryAuditAssignment reports
// allSubmitted: true — tells every auditor on this round the revision
// window is open. Reuses getFactoryAuditRoundProgress for the auditor list
// rather than re-querying AuditAssignment directly, so there's one place
// that knows how to enumerate "who's on this round."
export async function notifyFactoryAuditAllSubmitted(auditInstanceId: string) {
  const [instance, progress] = await Promise.all([
    prisma.factoryAuditInstance.findUnique({
      where: { id: auditInstanceId },
      select: { workspaceId: true, vendor: { select: { name: true } } },
    }),
    getFactoryAuditRoundProgress(auditInstanceId),
  ]);
  if (!instance) throw new ApiError(404, "Audit instance not found");

  const link = `/factory-audit/instances/${auditInstanceId}`;
  await Promise.all(
    progress.map((p) =>
      notify({
        workspaceId: instance.workspaceId,
        recipientId: p.auditorId,
        type: "GENERIC",
        title: "All scores submitted — revisions now open",
        body: `Every auditor has submitted scores for ${instance.vendor.name}'s factory audit. You can now revise your own scores before this round is finalized.`,
        link,
        metadata: { factoryAuditInstanceId: auditInstanceId },
      }),
    ),
  );
}

// Live progress — who's submitted, who hasn't, how much of their checklist
// each auditor has scored so far. Nothing stored: scoredCount is a count of
// FactoryAuditResponse rows, computed on read, same reasoning as everywhere
// else derivable data wasn't given its own column this session.
export async function getFactoryAuditRoundProgress(auditInstanceId: string) {
  const scope = await resolveInstanceCheckpointScope(auditInstanceId);

  const assignments = await prisma.auditAssignment.findMany({
    where: { auditInstanceId },
    include: {
      auditor: { select: { first_name: true, last_name: true } },
      responses: { where: { iteration: 1, checkpointId: { in: scope } } },
    },
  });

  return assignments.map((assignment) => ({
    assignmentId: assignment.id,
    auditorId: assignment.auditorId,
    auditor: assignment.auditor,
    role: assignment.role,
    status: assignment.status,
    scoredCount: assignment.responses.filter(isCheckpointScored).length,
    totalCheckpoints: scope.length,
  }));
}

function assignmentsAllSubmitted(assignments: { status: string }[]) {
  return (
    assignments.length > 0 && assignments.every((a) => a.status === "SUBMITTED")
  );
}

async function isFactoryAuditRoundFinalized(auditInstanceId: string) {
  const existingResult = await prisma.auditCheckpointResult.findFirst({
    where: { auditInstanceId },
    select: { id: true },
  });
  return existingResult != null;
}

// One row per (assignment, checkpoint), current iteration only — the
// side-by-side view the revision window is built around: every auditor's
// current score for every checkpoint, so each can see the others' before
// deciding whether to revise their own.
export async function getFactoryAuditRoundScoreComparison(
  auditInstanceId: string,
) {
  const scope = await resolveInstanceCheckpointScope(auditInstanceId);

  const responses = await prisma.factoryAuditResponse.findMany({
    where: { checkpointId: { in: scope }, assignment: { auditInstanceId } },
    include: {
      assignment: {
        include: { auditor: { select: { first_name: true, last_name: true } } },
      },
    },
    orderBy: { iteration: "asc" },
  });

  // "Current" = highest iteration per (assignmentId, checkpointId) — same
  // pattern as Dealer Audit's latestByItem in dealerAuditAssembler.ts, just
  // keyed on a compound (assignment, checkpoint) pair here instead of a
  // single itemId, since a checkpoint's current value is scoped per auditor.
  const currentByAssignmentCheckpoint = new Map<
    string,
    (typeof responses)[number]
  >();
  for (const response of responses) {
    const key = `${response.assignmentId}:${response.checkpointId}`;
    const current = currentByAssignmentCheckpoint.get(key);
    if (!current || response.iteration > current.iteration) {
      currentByAssignmentCheckpoint.set(key, response);
    }
  }

  const byCheckpoint = new Map<
    string,
    ReturnType<typeof buildComparisonRow>[]
  >();
  function buildComparisonRow(response: (typeof responses)[number]) {
    return {
      assignmentId: response.assignmentId,
      auditor: response.assignment.auditor,
      role: response.assignment.role,
      score: response.score,
      isNotApplicable: response.isNotApplicable,
      remark: response.remark,
      iteration: response.iteration,
    };
  }
  for (const response of currentByAssignmentCheckpoint.values()) {
    const row = buildComparisonRow(response);
    const rows = byCheckpoint.get(response.checkpointId) ?? [];
    rows.push(row);
    byCheckpoint.set(response.checkpointId, rows);
  }

  return scope.map((checkpointId) => ({
    checkpointId,
    auditorScores: byCheckpoint.get(checkpointId) ?? [],
  }));
}

// The one post-submission edit — only while the revision window is open
// (every assignment SUBMITTED, nothing finalized yet). Writes iteration 2,
// upserted in place if called again for the same checkpoint (still just
// "one more edit," not an open-ended history — see FactoryAuditResponse's
// own schema comment).
export async function reviseFactoryAuditCheckpointScore(
  auditorUserId: string,
  assignmentId: string,
  input: CheckpointScoreInput,
) {
  const assignment = await getOwnAssignmentOrThrow(assignmentId, auditorUserId);
  if (assignment.status !== "SUBMITTED") {
    throw new ApiError(
      400,
      "You can only revise a score after submitting your original one",
    );
  }

  const [siblingAssignments, finalized] = await Promise.all([
    prisma.auditAssignment.findMany({
      where: { auditInstanceId: assignment.auditInstanceId },
      select: { status: true },
    }),
    isFactoryAuditRoundFinalized(assignment.auditInstanceId),
  ]);
  if (!assignmentsAllSubmitted(siblingAssignments)) {
    throw new ApiError(
      400,
      "Revisions open once every auditor on this audit has submitted",
    );
  }
  if (finalized) {
    throw new ApiError(400, "This audit's scoring has already been finalized");
  }

  const scope = await resolveInstanceCheckpointScope(
    assignment.auditInstanceId,
  );
  assertCheckpointsInScope([input.checkpointId], scope);

  return prisma.factoryAuditResponse.upsert({
    where: {
      assignmentId_checkpointId_iteration: {
        assignmentId,
        checkpointId: input.checkpointId,
        iteration: 2,
      },
    },
    create: {
      assignmentId,
      checkpointId: input.checkpointId,
      iteration: 2,
      score: input.score ?? null,
      isNotApplicable: input.isNotApplicable ?? false,
      remark: input.remark,
    },
    update: {
      score: input.score ?? null,
      isNotApplicable: input.isNotApplicable ?? false,
      remark: input.remark,
    },
  });
}

// Reviewer-triggered, strict: every assignment must be SUBMITTED, no
// override for a stalled auditor — reassign their checkpoints instead (see
// AuditAssignment.reassignedFromId's own comment). A partial finalize would
// make "checkpoint has no result" ambiguous between "not in scope" and
// "auditor never scored it," which is worse than just blocking until the
// data is actually complete.
export async function finalizeFactoryAuditRoundScoring(
  auditInstanceId: string,
) {
  const assignments = await prisma.auditAssignment.findMany({
    where: { auditInstanceId },
    select: { status: true },
  });
  if (!assignmentsAllSubmitted(assignments)) {
    throw new ApiError(
      400,
      "Every assigned auditor must submit before scoring can be finalized",
    );
  }
  if (await isFactoryAuditRoundFinalized(auditInstanceId)) {
    throw new ApiError(400, "This audit's scoring has already been finalized");
  }

  const comparison = await getFactoryAuditRoundScoreComparison(auditInstanceId);

  const resultRows = comparison.map(({ checkpointId, auditorScores }) => {
    const scored = auditorScores.filter(
      (r) => !r.isNotApplicable && r.score != null,
    );
    const score = scored.length
      ? scored.reduce((sum, r) => sum + (r.score as number), 0) / scored.length
      : null; // every response was N/A — matches AuditCheckpointResult.score's own comment
    return { auditInstanceId, checkpointId, score };
  });

  return prisma.$transaction(
    resultRows.map((row) => prisma.auditCheckpointResult.create({ data: row })),
  );
}

// ─────────────────────────────────────────────
// Classification + approval submission
//
// Deliberately its own function, not folded into finalizeFactoryAuditRoundScoring
// above — finalize's one job is computing AuditCheckpointResult from
// whichever iteration is current per (assignment, checkpoint); this
// function's job starts only once that's already done (SRP: each has
// exactly one reason to change). Kept separate so a caller can finalize and
// let a reviewer inspect the frozen results before deciding to actually
// submit for approval, rather than the two being one inseparable action.
//
// Sequence (confirmed): finalize → generate the detailed report PDF
// synchronously → submit for approval. The PDF generation and the workflow
// creation both need the same classification numbers (overall %, band,
// which sections failed), so computeFactoryAuditClassification is called
// once here and its result is threaded into both — not recomputed twice in
// the same request. (getOrGeneratePdfUrl still calls it a second time
// internally, via factoryAuditAssembler.ts — unavoidable, since pdf.services.ts's
// registry contract is "assembleData(id)", not "assembleData(id, precomputed)".
// Cheap enough — one findMany over already-small AuditCheckpointResult rows —
// not worth widening that shared contract for.)
// ─────────────────────────────────────────────

export async function submitFactoryAuditForApproval(
  auditInstanceId: string,
  actorUserId: string,
) {
  if (!(await isFactoryAuditRoundFinalized(auditInstanceId))) {
    throw new ApiError(
      400,
      "Finalize this audit's scoring before submitting it for approval",
    );
  }

  const instance = await prisma.factoryAuditInstance.findUnique({
    where: { id: auditInstanceId },
    select: { workspaceId: true },
  });
  if (!instance) throw new ApiError(404, "Audit instance not found");

  // Seeded once per environment via the workspace RBAC setup (App.key is
  // unique) — looked up rather than hardcoded so this never drifts from
  // whatever id that seed actually produced.
  const app = await prisma.app.findUnique({ where: { key: "FACTORY_AUDIT" } });
  if (!app) {
    throw new ApiError(
      500,
      'Factory Audit app ("FACTORY_AUDIT") is not seeded for this workspace',
    );
  }

  const classification =
    await computeFactoryAuditClassification(auditInstanceId);

  // Synchronous — mirrors every other pdfDocumentRegistry type (no queue);
  // caches on a deterministic S3 key, so this is effectively a no-op if the
  // report was already generated once before (e.g. a prior failed attempt
  // to assign the workflow after the PDF had already rendered).
  await getOrGeneratePdfUrl("FACTORY_AUDIT", auditInstanceId);

  const { workflowInstance, stageOneApproverIds, stageOneId } =
    await prisma.$transaction((tx) =>
      assignWorkflow(tx, {
        subjectType: "FACTORY_AUDIT_INSTANCE",
        subjectId: auditInstanceId,
        workspaceId: instance.workspaceId,
        appId: app.id,
        userId: actorUserId,
        criteria: {
          bandLabel: classification.bandLabel,
          overallPercent: classification.overallPercent,
          sectionsFailed: classification.sectionsFailed.map((s) => s.sectionId),
        },
      }),
    );

  // After commit — same convention as every other assignWorkflow call site
  // (see that function's own comment in workflow.service.ts).
  if (stageOneId) {
    await notifyStageApprovers({
      workflowId: workflowInstance.id,
      subjectType: "FACTORY_AUDIT_INSTANCE",
      subjectId: auditInstanceId,
      appId: workflowInstance.appId,
      stageId: stageOneId,
      approverIds: stageOneApproverIds,
    });
  }

  return { workflowInstance, classification };
}

// ─────────────────────────────────────────────
// Reopen (Step 6)
//
// Confirmed this round: any Reviewer can trigger a reopen (no automatic
// creation off the postApprovalHook — that hook's only job stays writing
// VendorClassificationHistory, one reason to change); who's actually
// allowed to call this is an authorize("FACTORY_AUDIT", "FACTORY_AUDIT_REVIEW",
// "write") check at the route/controller layer once that's built, same
// pattern as every other app here — this service function takes an
// already-authorized actorUserId, same as scheduleFactoryAuditInstance does
// for createdByUserId, and doesn't re-derive role checks itself.
//
// Scope: only the failed sections' checkpoints carry over into
// scopedCheckpointIds — re-computed from computeFactoryAuditClassification
// rather than read off VendorClassificationHistory (which only stores the
// band/qualifiesFor/percent, not which sections failed) — same reasoning
// as everywhere else this session: AuditCheckpointResult is frozen once
// finalize creates it, so recomputing here is guaranteed to agree with
// whatever the postApprovalHook already persisted.
//
// Auditors: carried over verbatim from the root's own AuditAssignment rows
// (confirmed) — not from whichever instance actually failed, since a
// REOPEN is always created off the root INITIAL instance (the one-time cap
// makes "reopen a REOPEN" impossible: if a REOPEN itself lands on "No
// Approval", reopenUsed is already true and this function refuses).
// ─────────────────────────────────────────────

async function resolveRootInstanceId(instanceId: string): Promise<string> {
  const instance = await prisma.factoryAuditInstance.findUnique({
    where: { id: instanceId },
    select: { id: true, parentId: true },
  });
  if (!instance) throw new ApiError(404, "Audit instance not found");
  // Flat by design (confirmed) — a child's parentId always points directly
  // at the root, never at another child, so one hop is always enough.
  return instance.parentId ?? instance.id;
}

export async function reopenFactoryAuditInstance(
  auditInstanceId: string,
  actorUserId: string,
) {
  const rootId = await resolveRootInstanceId(auditInstanceId);

  const root = await prisma.factoryAuditInstance.findUnique({
    where: { id: rootId },
    include: { assignments: true },
  });
  if (!root) throw new ApiError(404, "Audit instance not found");
  if (root.reopenUsed) {
    throw new ApiError(
      400,
      "This audit's one-time reopen has already been used",
    );
  }

  const latestClassification =
    await prisma.vendorClassificationHistory.findFirst({
      where: { auditInstanceId },
      orderBy: { decidedAt: "desc" },
    });
  if (!latestClassification) {
    throw new ApiError(
      400,
      "This audit has no ratified classification decision yet",
    );
  }
  if (latestClassification.bandLabel !== "No Approval") {
    throw new ApiError(
      400,
      `Only a "No Approval" classification can be reopened (current: "${latestClassification.bandLabel}")`,
    );
  }

  const classification =
    await computeFactoryAuditClassification(auditInstanceId);
  if (!classification.sectionsFailed.length) {
    // Defensive — shouldn't happen if bandLabel is genuinely "No Approval"
    // (that band is only ever assigned via the hard gate), but a
    // classification landing on "No Approval" through resolveBandByPercent
    // alone (overall < 50%, no section actually below its own threshold)
    // would leave nothing to scope a reopen to.
    throw new ApiError(
      400,
      "No failed sections found to scope a reopen to — reopen the full audit manually if needed",
    );
  }
  const failedSectionIds = classification.sectionsFailed.map(
    (s) => s.sectionId,
  );
  const scopedCheckpoints = await prisma.factoryAuditCheckpoint.findMany({
    where: { sectionId: { in: failedSectionIds } },
    select: { id: true },
  });

  const reopenInstance = await prisma.$transaction(async (tx) => {
    await tx.factoryAuditInstance.update({
      where: { id: root.id },
      data: { reopenUsed: true },
    });

    return tx.factoryAuditInstance.create({
      data: {
        type: "REOPEN",
        parentId: root.id,
        vendorId: root.vendorId,
        workspaceId: root.workspaceId,
        templateId: root.templateId,
        createdByUserId: actorUserId,
        targetPartCategories: root.targetPartCategories,
        scopedCheckpointIds: scopedCheckpoints.map((c) => c.id),
        assignments: {
          create: root.assignments.map((a) => ({
            auditorId: a.auditorId,
            role: a.role,
          })),
        },
      },
      include: {
        assignments: {
          include: {
            auditor: { select: { first_name: true, last_name: true } },
          },
        },
      },
    });
  });

  await notifyFactoryAuditReopened(reopenInstance.id, rootId);

  return reopenInstance;
}

// Fired once, right after the reopen instance is committed — tells every
// carried-over auditor there's a new round to score. Reuses the same
// GENERIC notify() shape as notifyFactoryAuditAllSubmitted, just a
// different audience/message.
async function notifyFactoryAuditReopened(
  reopenInstanceId: string,
  rootInstanceId: string,
) {
  const [reopenInstance, root] = await Promise.all([
    prisma.factoryAuditInstance.findUnique({
      where: { id: reopenInstanceId },
      include: { assignments: true },
    }),
    prisma.factoryAuditInstance.findUnique({
      where: { id: rootInstanceId },
      select: { workspaceId: true, vendor: { select: { name: true } } },
    }),
  ]);
  if (!reopenInstance || !root)
    throw new ApiError(404, "Audit instance not found");

  const link = `/factory-audit/instances/${reopenInstance.id}`;
  await Promise.all(
    reopenInstance.assignments.map((a) =>
      notify({
        workspaceId: root.workspaceId,
        recipientId: a.auditorId,
        type: "GENERIC",
        title: "Audit reopened — rescoring required",
        body: `${root.vendor.name}'s factory audit has been reopened for the sections that didn't pass. Please re-score the flagged checkpoints.`,
        link,
        metadata: {
          factoryAuditInstanceId: reopenInstance.id,
          parentInstanceId: rootInstanceId,
        },
      }),
    ),
  );
}

// ─────────────────────────────────────────────
// Reviewer flag-for-improvement + SUB_AUDIT (Step 6, part 2)
//
// Distinct from REOPEN in two ways: uncapped (no reopenUsed-style gate —
// FactoryAuditInstanceType's own schema comment calls it "uncapped"), and
// scoped to whichever checkpoints a Reviewer has explicitly flagged
// (AuditCheckpointResult.reviewerFlaggedForImprovement) rather than to
// failed sections. A Reviewer can flag checkpoints on any already-finalized
// instance (root INITIAL or a REOPEN) while looking over its results —
// independent of that instance's own workflow status, since flagging is
// itself just an annotation, not an approval action.
// ─────────────────────────────────────────────

export async function flagFactoryAuditCheckpointForImprovement(
  auditInstanceId: string,
  checkpointId: string,
  reviewerId: string,
  remark: string,
) {
  const result = await prisma.auditCheckpointResult.findUnique({
    where: { auditInstanceId_checkpointId: { auditInstanceId, checkpointId } },
  });
  if (!result) {
    throw new ApiError(
      404,
      "No finalized result found for this checkpoint on this audit instance",
    );
  }

  return prisma.auditCheckpointResult.update({
    where: { id: result.id },
    data: {
      reviewerFlaggedForImprovement: true,
      reviewerRemark: remark,
      reviewerId,
      reviewerRemarkedAt: new Date(),
    },
  });
}

export async function unflagFactoryAuditCheckpoint(
  auditInstanceId: string,
  checkpointId: string,
) {
  const result = await prisma.auditCheckpointResult.findUnique({
    where: { auditInstanceId_checkpointId: { auditInstanceId, checkpointId } },
  });
  if (!result) {
    throw new ApiError(
      404,
      "No finalized result found for this checkpoint on this audit instance",
    );
  }

  return prisma.auditCheckpointResult.update({
    where: { id: result.id },
    data: {
      reviewerFlaggedForImprovement: false,
      reviewerRemark: null,
      reviewerId: null,
      reviewerRemarkedAt: null,
    },
  });
}

export async function createFactoryAuditSubAudit(
  auditInstanceId: string,
  actorUserId: string,
) {
  const rootId = await resolveRootInstanceId(auditInstanceId);
  const root = await prisma.factoryAuditInstance.findUnique({
    where: { id: rootId },
    include: { assignments: true },
  });
  if (!root) throw new ApiError(404, "Audit instance not found");

  const flaggedResults = await prisma.auditCheckpointResult.findMany({
    where: { auditInstanceId, reviewerFlaggedForImprovement: true },
    select: { checkpointId: true },
  });
  if (!flaggedResults.length) {
    throw new ApiError(
      400,
      "No checkpoints are flagged for improvement on this audit instance yet",
    );
  }

  const subAuditInstance = await prisma.factoryAuditInstance.create({
    data: {
      type: "SUB_AUDIT",
      parentId: root.id,
      vendorId: root.vendorId,
      workspaceId: root.workspaceId,
      templateId: root.templateId,
      createdByUserId: actorUserId,
      targetPartCategories: root.targetPartCategories,
      scopedCheckpointIds: flaggedResults.map((r) => r.checkpointId),
      assignments: {
        // Same default as REOPEN (confirmed): carry over the root's
        // auditor list. NOT yet separately confirmed for SUB_AUDIT —
        // flagging this assumption explicitly, since a sub-audit could
        // plausibly want a smaller/different team than a full reopen.
        // Easy to change to a caller-supplied assignments list if so.
        create: root.assignments.map((a) => ({
          auditorId: a.auditorId,
          role: a.role,
        })),
      },
    },
    include: {
      assignments: {
        include: { auditor: { select: { first_name: true, last_name: true } } },
      },
    },
  });

  await notifyFactoryAuditSubAuditCreated(subAuditInstance.id, rootId);

  return subAuditInstance;
}

async function notifyFactoryAuditSubAuditCreated(
  subAuditInstanceId: string,
  rootInstanceId: string,
) {
  const [subAuditInstance, root] = await Promise.all([
    prisma.factoryAuditInstance.findUnique({
      where: { id: subAuditInstanceId },
      include: { assignments: true },
    }),
    prisma.factoryAuditInstance.findUnique({
      where: { id: rootInstanceId },
      select: { workspaceId: true, vendor: { select: { name: true } } },
    }),
  ]);
  if (!subAuditInstance || !root)
    throw new ApiError(404, "Audit instance not found");

  const link = `/factory-audit/instances/${subAuditInstance.id}`;
  await Promise.all(
    subAuditInstance.assignments.map((a) =>
      notify({
        workspaceId: root.workspaceId,
        recipientId: a.auditorId,
        type: "GENERIC",
        title: "Sub-audit created — rescoring required",
        body: `A sub-audit has been created for ${root.vendor.name}'s factory audit, scoped to the checkpoints flagged for improvement. Please re-score them.`,
        link,
        metadata: {
          factoryAuditInstanceId: subAuditInstance.id,
          parentInstanceId: rootInstanceId,
        },
      }),
    ),
  );
}
