-- Migration 2 of 2: checklist template v2 (function / category as plain
-- text, score levels, evidence limits, reference photo, template description,
-- total score, audit stamps). Hand-written so existing templates, items
-- and the audits that point at them are preserved.
--
-- Needs Postgres 13+ for gen_random_uuid() (otherwise: CREATE EXTENSION pgcrypto).

-- ── 2. Template columns ──────────────────────────────────────────────

ALTER TABLE "ChecklistTemplate"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "totalScore"  DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "publishedAt" TIMESTAMP(3),
  ADD COLUMN "createdById" TEXT,
  ADD COLUMN "updatedById" TEXT;

CREATE INDEX "ChecklistTemplate_status_officeType_idx"
  ON "ChecklistTemplate"("status", "officeType");

-- ── 3. Item columns ──────────────────────────────────────────────────

ALTER TABLE "ChecklistItem"
  ADD COLUMN "functionName"       TEXT,
  ADD COLUMN "categoryName"       TEXT,
  ADD COLUMN "minEvidence"        INTEGER,
  ADD COLUMN "maxEvidence"        INTEGER,
  ADD COLUMN "referencePhotoKey"  TEXT,
  ALTER COLUMN "sectionName" DROP NOT NULL;

-- ── 4. Score levels ──────────────────────────────────────────────────

CREATE TABLE "ChecklistScoreLevel" (
  "id"       TEXT    NOT NULL,
  "itemId"   TEXT    NOT NULL,
  "score"    INTEGER NOT NULL,
  "criteria" TEXT    NOT NULL,
  CONSTRAINT "ChecklistScoreLevel_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ChecklistScoreLevel_itemId_score_key"
  ON "ChecklistScoreLevel"("itemId", "score");
ALTER TABLE "ChecklistScoreLevel"
  ADD CONSTRAINT "ChecklistScoreLevel_itemId_fkey"
    FOREIGN KEY ("itemId") REFERENCES "ChecklistItem"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 5. Backfill existing data ────────────────────────────────────────

-- Function: the old free-text sectionName (trimmed); "Common" when empty.
UPDATE "ChecklistItem"
SET "functionName" = COALESCE(NULLIF(trim("sectionName"), ''), 'Common');

-- Category: from the old INFRA / PROCESS enum (stays NULL when it was NULL).
UPDATE "ChecklistItem"
SET "categoryName" = CASE "category"::text
  WHEN 'INFRA'   THEN 'Infra'
  WHEN 'PROCESS' THEN 'Process'
  ELSE NULL
END;

-- Evidence limits: the product defaults (min 1, max 3).
UPDATE "ChecklistItem"
SET "minEvidence" = 1, "maxEvidence" = 3
WHERE "requiresEvidence" = true;

-- Score levels. Old rows only stored a top score + guidance, so build:
--   top level  = maxScore with the old guidance as its criteria
--   zero level = "Non-compliant" (only when maxScore > 0)
-- REVIEW: the zero level is a sensible default, not data we had.
INSERT INTO "ChecklistScoreLevel" ("id", "itemId", "score", "criteria")
SELECT gen_random_uuid()::text,
       i."id",
       LEAST(GREATEST(i."maxScore"::int, 0), 5),
       COALESCE(NULLIF(trim(i."scoringGuidance"), ''), 'Compliant')
FROM "ChecklistItem" i
WHERE i."requiresScore" = true AND i."maxScore" IS NOT NULL;

INSERT INTO "ChecklistScoreLevel" ("id", "itemId", "score", "criteria")
SELECT gen_random_uuid()::text, i."id", 0, 'Non-compliant'
FROM "ChecklistItem" i
WHERE i."requiresScore" = true
  AND i."maxScore" IS NOT NULL
  AND i."maxScore"::int > 0;

-- Totals and lifecycle.
UPDATE "ChecklistTemplate" t
SET "totalScore" = COALESCE((
  SELECT SUM(i."maxScore") FROM "ChecklistItem" i
  WHERE i."templateId" = t."id" AND i."requiresScore" = true
), 0);

-- A PUBLISHED template that is no longer the active one was superseded.
UPDATE "ChecklistTemplate"
SET "status" = 'ARCHIVED'
WHERE "status" = 'PUBLISHED' AND "isActive" = false;

UPDATE "ChecklistTemplate"
SET "publishedAt" = "updatedAt"
WHERE "status" IN ('PUBLISHED', 'ARCHIVED');
