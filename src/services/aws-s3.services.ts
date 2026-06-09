import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3Client = new S3Client({
  region: process.env.AWS_REGION!,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const BUCKET_NAME = process.env.AWS_S3_BUCKET_NAME!;

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface ImageUploadResult {
  s3Key: string; // stored in DB — used to delete the object on selective replace
  fileUrl: string; // full S3 URL — stored in DB, used to build pre-signed URL
}

// ─────────────────────────────────────────────────────────────────────────────
// buildImageS3Key
//
// Deterministic key: report-images/<epcId>/<position>.jpg
//
// Position-keyed (not uuid) so uploading to position 2 again
// overwrites the same S3 object — no orphaned files, no cleanup needed
// on selective replace.
// ─────────────────────────────────────────────────────────────────────────────

function buildImageS3Key(epcId: string, position: number): string {
  return `report-images/${epcId}/${position}.jpg`;
}

export async function uploadDeviationDoc(
  epcId: string,
  buffer: Buffer,
): Promise<{ s3Key: string; fileUrl: string }> {
  const s3Key = `deviation-docs/${epcId}.pdf`;

  await s3Client.send(
    new PutObjectCommand({
      // Bucket: process.env.S3_DEVIATION_DOCS_BUCKET_NAME!,
      Bucket: BUCKET_NAME,
      Key: s3Key,
      Body: buffer,
      ContentType: "application/pdf",
    }),
  );

  // const fileUrl = `https://${process.env.S3_DEVIATION_DOCS_BUCKET_NAME}.s3.amazonaws.com/${s3Key}`;
  const fileUrl = `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Key}`;

  return { s3Key, fileUrl };
}

// ─────────────────────────────────────────────────────────────────────────────
// uploadReportImage
//
// Uploads a single image buffer to S3 at the position-keyed path.
// Idempotent — re-uploading to the same position overwrites the old object.
// ─────────────────────────────────────────────────────────────────────────────

export async function uploadReportImage(
  epcId: string,
  position: number,
  fileBuffer: Buffer,
  mimeType: string,
): Promise<ImageUploadResult> {
  const s3Key = buildImageS3Key(epcId, position);

  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
      Body: fileBuffer,
      ContentType: mimeType,
    }),
  );

  const fileUrl = `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Key}`;

  return { s3Key, fileUrl };
}

// ─────────────────────────────────────────────────────────────────────────────
// deleteReportImage
//
// Deletes a single image by its S3 key.
// Idempotent — does not throw if the object is already gone.
// Called on selective replace before uploading the new image.
// ─────────────────────────────────────────────────────────────────────────────

export async function deleteReportImage(s3Key: string): Promise<void> {
  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// getSignedImageUrl
//
// Generates a pre-signed GET URL valid for `expiresInSeconds` (default 1 hour).
// Always use this for image access — the bucket is private.
// ─────────────────────────────────────────────────────────────────────────────

export async function getSignedImageUrl(
  s3Key: string,
  expiresInSeconds = 3600,
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: s3Key,
  });

  return getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });
}
