// Dealer Audit: checklist template admin API (library, builder, lifecycle).
// Contract: claude/dealer-audit-template-api-contract.md
//
// Lifecycle: DRAFT -> PUBLISHED -> ARCHIVED. Only drafts are editable or
// deletable. Published versions are immutable, so audits that snapshot one
// never change underneath them.

import { randomUUID } from "crypto";
import { prisma } from "@shared/config/prisma";
import ApiError from "@shared/utils/apiError";
import ValidationError, { FieldError } from "@shared/utils/validationError";
import { getSignedImageUrl, uploadToS3 } from "@shared/utils/aws-s3.services";
import {
  Prisma,
  BusinessPartnerOfficeType,
} from "../../prisma/generated/prisma/client";
import {
  ListQuery,
  ParameterInput,
  TemplateInput,
  parseTemplateBody,
} from "./dealerAuditTemplate.validation";

type Tx = Prisma.TransactionClient;

const REFERENCE_PHOTO_PREFIX = "dealer-audit-templates/reference-photos/";
const REFERENCE_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const REFERENCE_PHOTO_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const TEMPLATE_INCLUDE = {
  items: {
    orderBy: { order: "asc" as const },
    include: {
      scoreLevels: { orderBy: { score: "desc" as const } },
    },
  },
} satisfies Prisma.ChecklistTemplateInclude;

type TemplateWithItems = Prisma.ChecklistTemplateGetPayload<{
  include: typeof TEMPLATE_INCLUDE;
}>;

// ─────────────────────────────────────────────
// Response mappers
// ─────────────────────────────────────────────

async function getUserNames(ids: (string | null)[]) {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (!unique.length) return new Map<string, string>();
  const users = await prisma.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, first_name: true, last_name: true },
  });
  return new Map(
    users.map((u) => [
      u.id,
      [u.first_name, u.last_name].filter(Boolean).join(" ").trim(),
    ]),
  );
}

async function toDetail(template: TemplateWithItems) {
  const names = await getUserNames([template.updatedById]);

  const parameters = await Promise.all(
    template.items.map(async (item) => ({
      id: item.id,
      order: item.order,
      functionName: item.functionName,
      categoryName: item.categoryName,
      title: item.label,
      checkPoint: item.checkPoint,
      isScored: item.requiresScore,
      maxScore: item.maxScore,
      scoreLevels: item.scoreLevels.map((l) => ({
        score: l.score,
        criteria: l.criteria,
      })),
      evidenceRequired: item.requiresEvidence,
      minEvidenceCount: item.minEvidence,
      maxEvidenceCount: item.maxEvidence,
      referencePhotoKey: item.referencePhotoKey,
      referencePhotoUrl: item.referencePhotoKey
        ? await getSignedImageUrl(item.referencePhotoKey)
        : null,
    })),
  );

  return {
    id: template.id,
    name: template.name,
    description: template.description,
    officeType: template.officeType,
    version: template.version,
    status: template.status,
    isActive: template.isActive,
    totalScore: template.totalScore,
    publishedAt: template.publishedAt,
    updatedAt: template.updatedAt,
    updatedByName: template.updatedById
      ? (names.get(template.updatedById) ?? null)
      : null,
    parameters,
  };
}

async function loadDetailOrThrow(id: string, db: Tx | typeof prisma = prisma) {
  const template = await db.checklistTemplate.findUnique({
    where: { id },
    include: TEMPLATE_INCLUDE,
  });
  if (!template) throw new ApiError(404, "Template not found");
  return template;
}

// ─────────────────────────────────────────────
// 1. List
// ─────────────────────────────────────────────

export async function listTemplates(q: ListQuery) {
  const where: Prisma.ChecklistTemplateWhereInput = {
    status: q.status,
    officeType: q.officeType,
    ...(q.search
      ? {
          OR: [
            { name: { contains: q.search, mode: "insensitive" } },
            { description: { contains: q.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const direction = q.sortOrder;
  const orderBy: Prisma.ChecklistTemplateOrderByWithRelationInput[] =
    q.sortBy === "parameterCount"
      ? [{ items: { _count: direction } }]
      : [{ [q.sortBy]: direction }];
  // Stable tiebreaker so pages never shuffle.
  orderBy.push({ id: "asc" });

  const [total, rows] = await Promise.all([
    prisma.checklistTemplate.count({ where }),
    prisma.checklistTemplate.findMany({
      where,
      orderBy,
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: { _count: { select: { items: true } } },
    }),
  ]);

  const names = await getUserNames(rows.map((r) => r.updatedById));

  return {
    items: rows.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      officeType: t.officeType,
      version: t.version,
      status: t.status,
      parameterCount: t._count.items,
      totalScore: t.totalScore,
      updatedAt: t.updatedAt,
      updatedByName: t.updatedById ? (names.get(t.updatedById) ?? null) : null,
    })),
    meta: {
      page: q.page,
      pageSize: q.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
    },
  };
}

// ─────────────────────────────────────────────
// 2. Detail
// ─────────────────────────────────────────────

export async function getTemplateById(id: string) {
  return toDetail(await loadDetailOrThrow(id));
}

// ─────────────────────────────────────────────
// Shared write helpers
// ─────────────────────────────────────────────

const duplicateNameError = () =>
  new ValidationError([
    {
      path: "name",
      message: "A template with this name already exists for this facility type",
    },
  ]);

// Reference photos must be keys this API handed out (never arbitrary S3
// paths), otherwise getSignedImageUrl could sign any object in the bucket.
function assertPhotoKeys(parameters: ParameterInput[]) {
  const errors: FieldError[] = [];
  parameters.forEach((p, i) => {
    if (p.referencePhotoKey && !p.referencePhotoKey.startsWith(REFERENCE_PHOTO_PREFIX))
      errors.push({ path: `parameters.${i}.referencePhotoKey`, message: "Invalid reference photo" });
  });
  if (errors.length) throw new ValidationError(errors);
}

// Old execution / report code still reads sectionName, category and
// scoringGuidance. Keep them populated until that code moves to the new
// columns, then drop the three columns (see schema note).
function legacyCategory(name: string | undefined): "INFRA" | "PROCESS" | undefined {
  const n = name?.toLowerCase();
  if (n === "infra") return "INFRA";
  if (n === "process") return "PROCESS";
  return undefined;
}

function itemColumns(p: ParameterInput, order: number) {
  const levels = [...p.scoreLevels].sort((a, b) => b.score - a.score);
  const scored = p.isScored;
  return {
    order,
    functionName: p.functionName,
    categoryName: p.categoryName,
    label: p.title,
    checkPoint: p.checkPoint,
    requiresScore: scored,
    maxScore: scored && levels.length ? levels[0].score : null,
    requiresEvidence: p.evidenceRequired,
    minEvidence: p.minEvidenceCount,
    maxEvidence: p.maxEvidenceCount,
    referencePhotoKey: p.referencePhotoKey,
    // legacy mirror (see legacyCategory)
    sectionName: p.functionName,
    category: legacyCategory(p.categoryName ?? undefined) ?? null,
    scoringGuidance: scored
      ? levels.map((l) => `${l.score}: ${l.criteria}`).join("; ") || null
      : null,
  };
}

// Replaces a draft's parameters with the submitted list. Ids that belong to
// this template are kept (so they stay stable), unknown or missing ones are
// created or deleted. (templateId, order) is unique, so existing rows are
// parked on negative orders first, then moved into place.
async function saveParameters(
  tx: Tx,
  templateId: string,
  parameters: ParameterInput[],
) {
  assertPhotoKeys(parameters);

  const existing = await tx.checklistItem.findMany({
    where: { templateId },
    select: { id: true },
  });
  const existingIds = new Set(existing.map((e) => e.id));
  const keptIds = new Set(
    parameters.map((p) => p.id).filter((id): id is string => !!id && existingIds.has(id)),
  );

  await tx.checklistItem.deleteMany({
    where: { templateId, id: { notIn: [...keptIds] } },
  });

  let parked = 0;
  for (const id of keptIds) {
    parked += 1;
    await tx.checklistItem.update({ where: { id }, data: { order: -parked } });
  }

  let total = 0;
  for (let i = 0; i < parameters.length; i++) {
    const p = parameters[i];
    const cols = itemColumns(p, i + 1);
    if (cols.requiresScore && cols.maxScore) total += cols.maxScore;

    const levelRows = p.isScored
      ? p.scoreLevels.map((l) => ({ score: l.score, criteria: l.criteria }))
      : [];

    if (p.id && keptIds.has(p.id)) {
      await tx.checklistItem.update({
        where: { id: p.id },
        data: {
          ...cols,
          category: cols.category ?? null,
          scoreLevels: {
            deleteMany: {},
            create: levelRows,
          },
        },
      });
    } else {
      await tx.checklistItem.create({
        data: {
          ...cols,
          category: cols.category ?? undefined,
          templateId,
          scoreLevels: { create: levelRows },
        },
      });
    }
  }

  return total;
}

// ─────────────────────────────────────────────
// 4. Create draft
// ─────────────────────────────────────────────

export async function createTemplate(userId: string, body: unknown) {
  const input = parseTemplateBody(body, { mode: "draft" });

  const dupe = await prisma.checklistTemplate.findFirst({
    where: { name: input.name, officeType: input.officeType },
    select: { id: true },
  });
  if (dupe) throw duplicateNameError();

  try {
    const id = await prisma.$transaction(async (tx) => {
      const created = await tx.checklistTemplate.create({
        data: {
          name: input.name,
          description: input.description,
          officeType: input.officeType,
          version: 1,
          status: "DRAFT",
          isActive: false,
          createdById: userId,
          updatedById: userId,
        },
      });
      const total = await saveParameters(tx, created.id, input.parameters);
      await tx.checklistTemplate.update({
        where: { id: created.id },
        data: { totalScore: total },
      });
      return created.id;
    });
    return toDetail(await loadDetailOrThrow(id));
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
      throw duplicateNameError();
    throw e;
  }
}

// ─────────────────────────────────────────────
// 5. Save draft (optimistic concurrency)
// ─────────────────────────────────────────────

export async function updateTemplateDraft(
  userId: string,
  id: string,
  body: unknown,
) {
  const input = parseTemplateBody(body, { mode: "draft" });
  if (!input.expectedUpdatedAt) {
    throw new ValidationError([
      { path: "expectedUpdatedAt", message: "expectedUpdatedAt is required" },
    ]);
  }

  const current = await prisma.checklistTemplate.findUnique({ where: { id } });
  if (!current) throw new ApiError(404, "Template not found");
  if (current.status !== "DRAFT") {
    throw new ApiError(
      409,
      "Only a draft can be edited. Create a new version to make changes.",
    );
  }

  const renamed =
    input.name !== current.name || input.officeType !== current.officeType;
  if (renamed) {
    const dupe = await prisma.checklistTemplate.findFirst({
      where: {
        name: input.name,
        officeType: input.officeType,
        version: current.version,
        id: { not: id },
      },
      select: { id: true },
    });
    if (dupe) throw duplicateNameError();
  }

  const stale = () =>
    new ApiError(
      409,
      "This template was changed by someone else. Reload to get the latest version.",
    );
  if (new Date(input.expectedUpdatedAt).getTime() !== current.updatedAt.getTime())
    throw stale();

  try {
    await prisma.$transaction(async (tx) => {
      // The updatedAt condition makes the check atomic: if another save
      // slipped in after the read above, nothing matches and we bail.
      const claimed = await tx.checklistTemplate.updateMany({
        where: { id, status: "DRAFT", updatedAt: current.updatedAt },
        data: {
          name: input.name,
          description: input.description,
          officeType: input.officeType,
          updatedById: userId,
          updatedAt: new Date(),
        },
      });
      if (claimed.count !== 1) throw stale();

      const total = await saveParameters(tx, id, input.parameters);
      await tx.checklistTemplate.update({
        where: { id },
        data: { totalScore: total },
      });
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
      throw duplicateNameError();
    throw e;
  }

  return toDetail(await loadDetailOrThrow(id));
}

// ─────────────────────────────────────────────
// 6. Publish
// ─────────────────────────────────────────────

export async function publishTemplate(
  userId: string,
  id: string,
  expectedUpdatedAt?: string,
) {
  const template = await loadDetailOrThrow(id);
  if (template.status !== "DRAFT") {
    throw new ApiError(409, "Only a draft can be published");
  }
  if (
    expectedUpdatedAt &&
    new Date(expectedUpdatedAt).getTime() !== template.updatedAt.getTime()
  ) {
    throw new ApiError(
      409,
      "This template was changed by someone else. Reload to get the latest version.",
    );
  }

  // Re-run the full publish rules on what is actually stored, so a draft
  // that was saved loosely can't be published incomplete.
  const input: TemplateInput = parseTemplateBody(
    {
      name: template.name,
      description: template.description,
      officeType: template.officeType,
      parameters: template.items.map((i) => ({
        id: i.id,
        functionName: i.functionName,
        categoryName: i.categoryName,
        title: i.label,
        checkPoint: i.checkPoint,
        isScored: i.requiresScore,
        scoreLevels: i.scoreLevels.map((l) => ({ score: l.score, criteria: l.criteria })),
        evidenceRequired: i.requiresEvidence,
        minEvidenceCount: i.minEvidence,
        maxEvidenceCount: i.maxEvidence,
        referencePhotoKey: i.referencePhotoKey,
      })),
    },
    { mode: "publish" },
  );

  const totalScore = input.parameters.reduce((sum, p) => {
    if (!p.isScored || !p.scoreLevels.length) return sum;
    return sum + Math.max(...p.scoreLevels.map((l) => l.score));
  }, 0);

  await prisma.$transaction(async (tx) => {
    // The version audits used until now steps down to ARCHIVED.
    await tx.checklistTemplate.updateMany({
      where: {
        name: template.name,
        officeType: template.officeType,
        status: "PUBLISHED",
        id: { not: id },
      },
      data: { status: "ARCHIVED", isActive: false },
    });

    await tx.checklistTemplate.update({
      where: { id },
      data: {
        status: "PUBLISHED",
        isActive: true,
        totalScore,
        publishedAt: new Date(),
        updatedById: userId,
      },
    });
  });

  return toDetail(await loadDetailOrThrow(id));
}

// ─────────────────────────────────────────────
// 7. New draft version
// ─────────────────────────────────────────────

export async function createNewDraftVersion(userId: string, id: string) {
  const source = await loadDetailOrThrow(id);
  if (source.status === "DRAFT") {
    throw new ApiError(409, "This template is already a draft");
  }

  const openDraft = await prisma.checklistTemplate.findFirst({
    where: { name: source.name, officeType: source.officeType, status: "DRAFT" },
    select: { id: true, version: true },
  });
  if (openDraft) {
    throw new ApiError(
      409,
      `A draft (v${openDraft.version}) of this template already exists. Edit that one instead.`,
    );
  }

  const latest = await prisma.checklistTemplate.aggregate({
    where: { name: source.name, officeType: source.officeType },
    _max: { version: true },
  });
  const version = (latest._max.version ?? source.version) + 1;

  const newId = await prisma.$transaction(async (tx) => {
    const draft = await tx.checklistTemplate.create({
      data: {
        name: source.name,
        description: source.description,
        officeType: source.officeType,
        version,
        status: "DRAFT",
        isActive: false,
        totalScore: source.totalScore,
        createdById: userId,
        updatedById: userId,
      },
    });

    for (const item of source.items) {
      await tx.checklistItem.create({
        data: {
          templateId: draft.id,
          order: item.order,
          functionName: item.functionName,
          categoryName: item.categoryName,
          label: item.label,
          checkPoint: item.checkPoint,
          requiresScore: item.requiresScore,
          maxScore: item.maxScore,
          requiresEvidence: item.requiresEvidence,
          minEvidence: item.minEvidence,
          maxEvidence: item.maxEvidence,
          referencePhotoKey: item.referencePhotoKey,
          sectionName: item.sectionName,
          category: item.category ?? undefined,
          scoringGuidance: item.scoringGuidance,
          scoreLevels: {
            create: item.scoreLevels.map((l) => ({
              score: l.score,
              criteria: l.criteria,
            })),
          },
        },
      });
    }
    return draft.id;
  });

  return toDetail(await loadDetailOrThrow(newId));
}

// ─────────────────────────────────────────────
// 8. Archive
// ─────────────────────────────────────────────

export async function archiveTemplate(userId: string, id: string) {
  const template = await prisma.checklistTemplate.findUnique({ where: { id } });
  if (!template) throw new ApiError(404, "Template not found");
  if (template.status !== "PUBLISHED") {
    throw new ApiError(409, "Only a published template can be archived");
  }

  // Running audits keep their version (they point at this row); it just
  // stops being picked up for new audits.
  await prisma.checklistTemplate.update({
    where: { id },
    data: { status: "ARCHIVED", isActive: false, updatedById: userId },
  });

  return toDetail(await loadDetailOrThrow(id));
}

// ─────────────────────────────────────────────
// 9. Delete (draft only)
// ─────────────────────────────────────────────

export async function deleteTemplate(id: string) {
  const template = await prisma.checklistTemplate.findUnique({ where: { id } });
  if (!template) throw new ApiError(404, "Template not found");
  if (template.status !== "DRAFT") {
    throw new ApiError(409, "Only a draft can be deleted. Archive it instead.");
  }

  const inUse = await prisma.dealerAuditInstance.count({
    where: { checklistTemplateId: id },
  });
  if (inUse > 0) {
    throw new ApiError(409, "This template is used by existing audits and cannot be deleted");
  }

  await prisma.checklistTemplate.delete({ where: { id } }); // items + levels cascade
}

// ─────────────────────────────────────────────
// 10. Reference photo upload
// ─────────────────────────────────────────────

export async function uploadReferencePhoto(file: Express.Multer.File | undefined) {
  if (!file) throw new ApiError(400, "An image file is required");

  const ext = REFERENCE_PHOTO_TYPES[file.mimetype];
  if (!ext) throw new ApiError(400, "Only JPG, PNG or WebP images are allowed");
  if (file.size > REFERENCE_PHOTO_MAX_BYTES)
    throw new ApiError(400, "Image must be 5 MB or smaller");

  const key = `${REFERENCE_PHOTO_PREFIX}${randomUUID()}.${ext}`;
  await uploadToS3(key, file.buffer, file.mimetype);

  return { key, url: await getSignedImageUrl(key) };
}
