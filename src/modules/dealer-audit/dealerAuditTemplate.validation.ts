// Request validation for the checklist template API. Hand-written (no zod
// dependency needed on the backend). Messages mirror the frontend schemas so
// the same text shows whether the browser or the server caught it.

import ValidationError, { FieldError } from "@shared/utils/validationError";
import { BusinessPartnerOfficeType } from "../../prisma/generated/prisma/client";

export const LIMITS = {
  nameMax: 120,
  descriptionMax: 500,
  titleMax: 250,
  labelMax: 100, // function / category text
  checkPointMax: 1000,
  criteriaMax: 250,
  scoreMin: 0,
  scoreMax: 5,
  levelsMin: 2,
  levelsMax: 6,
  evidenceMaxLimit: 10,
} as const;

export type ScoreLevelInput = { score: number; criteria: string };

export type ParameterInput = {
  id?: string;
  functionName: string | null;
  categoryName: string | null;
  title: string;
  checkPoint: string;
  isScored: boolean;
  scoreLevels: ScoreLevelInput[];
  evidenceRequired: boolean;
  minEvidenceCount: number | null;
  maxEvidenceCount: number | null;
  referencePhotoKey: string | null;
};

export type TemplateInput = {
  name: string;
  description: string | null;
  officeType: BusinessPartnerOfficeType;
  parameters: ParameterInput[];
  expectedUpdatedAt?: string;
};

const OFFICE_TYPES = new Set<string>(["HEAD_OFFICE", "BRANCH_OFFICE"]);

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v);

type Options = {
  // "draft": loose, only shape + length limits. "publish": full rules.
  mode: "draft" | "publish";
};

// Normalises a raw body into TemplateInput and collects every error.
// Throws ValidationError (422) when anything is wrong.
export function parseTemplateBody(body: unknown, opts: Options): TemplateInput {
  const errors: FieldError[] = [];
  const add = (path: string, message: string) => errors.push({ path, message });

  if (!isObj(body)) {
    throw new ValidationError([{ path: "", message: "Request body is required" }]);
  }

  // ── Details ──
  const name = str(body.name);
  if (!name) add("name", "Template name is required");
  else if (name.length > LIMITS.nameMax)
    add("name", `Template name must be ${LIMITS.nameMax} characters or fewer`);

  const description = str(body.description) || null;
  if (description && description.length > LIMITS.descriptionMax)
    add(
      "description",
      `Description must be ${LIMITS.descriptionMax} characters or fewer`,
    );

  const officeType = body.officeType as string;
  if (!officeType || !OFFICE_TYPES.has(officeType))
    add("officeType", "Select a facility type");

  // ── Parameters ──
  const rawParams = body.parameters === undefined ? [] : body.parameters;
  const parameters: ParameterInput[] = [];

  if (!Array.isArray(rawParams)) {
    add("parameters", "Parameters must be a list");
  } else {
    if (opts.mode === "publish" && rawParams.length === 0)
      add("parameters", "Add at least one parameter before publishing");

    rawParams.forEach((raw, i) => {
      const p = `parameters.${i}`;
      if (!isObj(raw)) return add(p, "Invalid parameter");

      const title = str(raw.title);
      const checkPoint = str(raw.checkPoint);
      // Function / Category are free text here: the allowed lists live in the
      // frontend dropdowns, the backend only stores what it is sent.
      const functionName = str(raw.functionName) || null;
      const categoryName = str(raw.categoryName) || null;
      const isScored = raw.isScored !== false; // scored unless explicitly off
      const evidenceRequired = raw.evidenceRequired === true;

      // Length limits apply to drafts too.
      if (functionName && functionName.length > LIMITS.labelMax)
        add(`${p}.functionName`, `Function must be ${LIMITS.labelMax} characters or fewer`);
      if (categoryName && categoryName.length > LIMITS.labelMax)
        add(`${p}.categoryName`, `Category must be ${LIMITS.labelMax} characters or fewer`);
      if (title.length > LIMITS.titleMax)
        add(`${p}.title`, `Parameter must be ${LIMITS.titleMax} characters or fewer`);
      if (checkPoint.length > LIMITS.checkPointMax)
        add(
          `${p}.checkPoint`,
          `Check point must be ${LIMITS.checkPointMax} characters or fewer`,
        );

      // Score levels (shape always; rules at publish).
      const levels: ScoreLevelInput[] = [];
      const rawLevels = Array.isArray(raw.scoreLevels) ? raw.scoreLevels : [];
      rawLevels.forEach((lv, j) => {
        const lp = `${p}.scoreLevels.${j}`;
        if (!isObj(lv)) return add(lp, "Invalid score level");
        const score = lv.score;
        const criteria = str(lv.criteria);
        if (criteria.length > LIMITS.criteriaMax)
          add(`${lp}.criteria`, `Criteria must be ${LIMITS.criteriaMax} characters or fewer`);
        if (
          !isInt(score) ||
          score < LIMITS.scoreMin ||
          score > LIMITS.scoreMax
        ) {
          add(
            `${lp}.score`,
            `Score must be a whole number from ${LIMITS.scoreMin} to ${LIMITS.scoreMax}`,
          );
          return;
        }
        levels.push({ score, criteria });
      });

      // Evidence numbers (shape always).
      const minEv = raw.minEvidenceCount;
      const maxEv = raw.maxEvidenceCount;
      const minEvidenceCount = isInt(minEv) ? minEv : null;
      const maxEvidenceCount = isInt(maxEv) ? maxEv : null;

      if (opts.mode === "publish") {
        if (!functionName) add(`${p}.functionName`, "Select a function");
        if (!categoryName) add(`${p}.categoryName`, "Select a category");

        if (!title) add(`${p}.title`, "Parameter is required");
        if (!checkPoint) add(`${p}.checkPoint`, "Check point / criteria is required");

        if (isScored) {
          if (levels.length < LIMITS.levelsMin || levels.length > LIMITS.levelsMax)
            add(
              `${p}.scoreLevels`,
              `Add ${LIMITS.levelsMin} to ${LIMITS.levelsMax} score levels`,
            );
          const seen = new Set<number>();
          levels.forEach((lv, j) => {
            if (seen.has(lv.score))
              add(`${p}.scoreLevels.${j}.score`, "Each score can be used only once");
            seen.add(lv.score);
            if (!lv.criteria)
              add(`${p}.scoreLevels.${j}.criteria`, "Criteria is required");
          });
        }

        if (evidenceRequired) {
          if (minEvidenceCount === null || minEvidenceCount < 1)
            add(
              `${p}.minEvidenceCount`,
              "Minimum evidence must be a whole number of 1 or more",
            );
          if (
            maxEvidenceCount === null ||
            maxEvidenceCount > LIMITS.evidenceMaxLimit
          )
            add(
              `${p}.maxEvidenceCount`,
              `Maximum evidence can be at most ${LIMITS.evidenceMaxLimit}`,
            );
          else if (minEvidenceCount !== null && maxEvidenceCount < minEvidenceCount)
            add(
              `${p}.maxEvidenceCount`,
              "Maximum evidence must be at least the minimum",
            );
        }
      }

      parameters.push({
        id: str(raw.id) || undefined,
        functionName,
        categoryName,
        title,
        checkPoint,
        isScored,
        scoreLevels: levels,
        evidenceRequired,
        minEvidenceCount: evidenceRequired ? minEvidenceCount : null,
        maxEvidenceCount: evidenceRequired ? maxEvidenceCount : null,
        referencePhotoKey: str(raw.referencePhotoKey) || null,
      });
    });
  }

  if (errors.length) throw new ValidationError(errors);

  return {
    name,
    description,
    officeType: officeType as BusinessPartnerOfficeType,
    parameters,
    expectedUpdatedAt:
      typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : undefined,
  };
}

// ── List query ──
export const SORTABLE = [
  "name",
  "officeType",
  "version",
  "status",
  "parameterCount",
  "updatedAt",
] as const;
export type SortBy = (typeof SORTABLE)[number];

export type ListQuery = {
  search?: string;
  status?: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  officeType?: BusinessPartnerOfficeType;
  sortBy: SortBy;
  sortOrder: "asc" | "desc";
  page: number;
  pageSize: number;
};

export function parseListQuery(q: Record<string, unknown>): ListQuery {
  const errors: FieldError[] = [];
  const one = (v: unknown) => (typeof v === "string" ? v.trim() : "");

  const status = one(q.status).toUpperCase();
  if (status && !["DRAFT", "PUBLISHED", "ARCHIVED"].includes(status))
    errors.push({ path: "status", message: "Invalid status" });

  const officeType = one(q.officeType).toUpperCase();
  if (officeType && !OFFICE_TYPES.has(officeType))
    errors.push({ path: "officeType", message: "Invalid facility type" });

  const sortBy = one(q.sortBy) || "updatedAt";
  if (!(SORTABLE as readonly string[]).includes(sortBy))
    errors.push({ path: "sortBy", message: "Invalid sort column" });

  if (errors.length) throw new ValidationError(errors);

  const page = Math.max(1, parseInt(one(q.page), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(one(q.pageSize), 10) || 10));

  return {
    search: one(q.search) || undefined,
    status: (status || undefined) as ListQuery["status"],
    officeType: (officeType || undefined) as ListQuery["officeType"],
    sortBy: sortBy as SortBy,
    sortOrder: one(q.sortOrder).toLowerCase() === "asc" ? "asc" : "desc",
    page,
    pageSize,
  };
}
