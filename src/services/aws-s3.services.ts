import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { v4 as uuidv4 } from "uuid";

const s3Client = new S3Client({
  region: process.env.AWS_REGION!,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME!;

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface UploadResult {
  s3Key: string; // stored in DB — used to delete the object later
  fileUrl: string; // the full S3 URL — stored in DB for access
}

// ─────────────────────────────────────────────────────────────────────────────
// buildS3Key
//
// Deterministic key structure: reports/<epcId>/<uuid>.pdf
// Scoping by epcId makes it easy to list or purge all files for an EPC.
// ─────────────────────────────────────────────────────────────────────────────

function buildS3Key(epcId: string): string {
  return `reports/${epcId}/${uuidv4()}.pdf`;
}

// ─────────────────────────────────────────────────────────────────────────────
// uploadReportPdf
//
// Uploads a PDF buffer to S3 under the reports/<epcId>/ prefix.
// Returns the s3Key (for future deletion) and the fileUrl (for access).
// ─────────────────────────────────────────────────────────────────────────────

export async function uploadReportPdf(
  epcId: string,
  fileBuffer: Buffer,
): Promise<UploadResult> {
  const s3Key = buildS3Key(epcId);

  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
      Body: fileBuffer,
      ContentType: "application/pdf",
    }),
  );

  const fileUrl = `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Key}`;

  return { s3Key, fileUrl };
}

// ─────────────────────────────────────────────────────────────────────────────
// deleteReportPdf
//
// Deletes an S3 object by its key.
// Called before uploading a replacement file on resubmission.
// Does not throw if the object is already gone (idempotent).
// ─────────────────────────────────────────────────────────────────────────────

export async function deleteReportPdf(s3Key: string): Promise<void> {
  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// getSignedReportUrl
//
// Generates a pre-signed GET URL valid for `expiresInSeconds` (default 1 hour).
// Use this if your bucket is private and you want time-limited access.
// If your bucket is public, use fileUrl directly and skip this.
// ─────────────────────────────────────────────────────────────────────────────

export async function getSignedReportUrl(
  s3Key: string,
  expiresInSeconds = 3600,
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: s3Key,
  });

  return getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });
}
