// Pure helpers + S3 resolution for EPF line-item attachments (one JPEG or
// PDF per line item, ≤5MB). Kept out of epf.controller.ts per the
// pure-function/helper-file convention — only the two S3-touching
// functions at the bottom are impure.

import { randomUUID } from "crypto";
import {
  getSignedImageUrl,
  deleteReportImage,
} from "@shared/utils/aws-s3.services";

// ─────────────────────────────────────────────────────────────────────────
// Accepted file types
//
// Single source of truth: epf.routes.ts's multer fileFilter validates
// against these keys, and buildLineItemAttachmentS3Key below derives the
// stored file's extension from the same map — one list, two uses.
// ─────────────────────────────────────────────────────────────────────────

export const LINE_ITEM_ATTACHMENT_MIME_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "application/pdf": "pdf",
};

export const LINE_ITEM_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

// ─────────────────────────────────────────────────────────────────────────
// buildLineItemAttachmentS3Key
//
// Nested under the EPC (not the line item) because a line item doesn't
// have an id yet at upload time — it's created afterwards, as part of the
// EPF create/update transaction. Randomised per upload rather than
// position-keyed, since a line item can be reordered/removed freely
// before submit.
// ─────────────────────────────────────────────────────────────────────────

export const buildLineItemAttachmentS3Key = (
  epcId: string,
  mimetype: string,
): string => {
  const extension = LINE_ITEM_ATTACHMENT_MIME_TYPES[mimetype];
  return `epf/${epcId}/line-items/${randomUUID()}.${extension}`;
};

// ─────────────────────────────────────────────────────────────────────────
// diffOrphanedAttachmentKeys
//
// Which previously-stored attachment keys are no longer referenced by the
// incoming line items. Used by updateEPF, which replaces all of an EPF's
// line items on every save (delete + recreate) — so every save needs this
// diff to know which S3 objects it just orphaned.
// ─────────────────────────────────────────────────────────────────────────

export const diffOrphanedAttachmentKeys = (
  previousKeys: (string | null | undefined)[],
  nextKeys: (string | null | undefined)[],
): string[] => {
  const keptKeys = new Set(
    nextKeys.filter((key): key is string => Boolean(key)),
  );

  return previousKeys.filter(
    (key): key is string => Boolean(key) && !keptKeys.has(key as string),
  );
};

// ─────────────────────────────────────────────────────────────────────────
// withLineItemAttachmentUrls
//
// S3 keys are stored, not URLs (presigned URLs expire) — see
// decisions-and-learnings.md. Resolved fresh on every read, same
// convention as MedicalClaimBill.s3Key.
// ─────────────────────────────────────────────────────────────────────────

type LineItemWithAttachment = {
  attachmentS3Key?: string | null;
};

export const withLineItemAttachmentUrls = async <
  T extends LineItemWithAttachment,
>(
  lineItems: T[],
): Promise<(T & { attachmentUrl: string | null })[]> => {
  return Promise.all(
    lineItems.map(async (item) => ({
      ...item,
      attachmentUrl: item.attachmentS3Key
        ? await getSignedImageUrl(item.attachmentS3Key)
        : null,
    })),
  );
};

// ─────────────────────────────────────────────────────────────────────────
// deleteOrphanedAttachments
//
// Best-effort cleanup, called after the DB transaction that dropped these
// keys has already committed. Logs and swallows individual failures so one
// bad key never surfaces as a failure on a request whose DB write already
// succeeded.
// ─────────────────────────────────────────────────────────────────────────

export const deleteOrphanedAttachments = async (
  s3Keys: string[],
): Promise<void> => {
  await Promise.all(
    s3Keys.map((key) =>
      deleteReportImage(key).catch((error) => {
        console.error(
          `Failed to delete orphaned line-item attachment ${key}:`,
          error,
        );
      }),
    ),
  );
};
