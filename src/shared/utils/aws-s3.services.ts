import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
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

// ─────────────────────────────────────────────────────────────────────────────
// uploadToS3
//
// Uploads a raw buffer with an explicit content type.
// Used by the import controller to store the incoming CSV/XLSX on S3
// before handing the S3 key to the BullMQ worker.
//
// WHY upload before enqueuing:
//   We never pass large file buffers through Redis — job payloads should be
//   small (just a reference). The worker downloads the file from S3 directly.
// ─────────────────────────────────────────────────────────────────────────────

export async function uploadToS3(
  s3Key: string,
  buffer: Buffer,
  contentType: string,
): Promise<void> {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
      Body: buffer,
      ContentType: contentType,
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// uploadBufferToS3
//
// Uploads a generated file buffer (CSV or XLSX) to S3 with a
// Content-Disposition header so browsers prompt a download with the
// correct filename when the pre-signed URL is opened.
//
// Used by export workers after building the file buffer in memory.
// ─────────────────────────────────────────────────────────────────────────────

export async function uploadBufferToS3(
  s3Key: string,
  buffer: Buffer,
  filename: string,
): Promise<void> {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
      Body: buffer,
      ContentDisposition: `attachment; filename="${filename}"`,
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// downloadFromS3
//
// Downloads an S3 object and returns its content as a Buffer.
// Used by the import worker to retrieve the uploaded CSV/XLSX file.
//
// Streams the response body into a Buffer rather than loading it all at once
// because the AWS SDK v3 returns a ReadableStream, not a Buffer directly.
// ─────────────────────────────────────────────────────────────────────────────

export async function downloadFromS3(s3Key: string): Promise<Buffer> {
  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
    }),
  );

  // AWS SDK v3 returns Body as a ReadableStream (Node.js) or Web ReadableStream
  // (browser). We're in Node.js so cast accordingly.
  const stream = response.Body as NodeJS.ReadableStream;

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// getSignedReportUrl
//
// Alias of getSignedImageUrl — same pre-signed GET logic, named separately
// so export workers can import it without coupling to image-specific naming.
// ─────────────────────────────────────────────────────────────────────────────

export async function objectExistsInS3(s3Key: string): Promise<boolean> {
  try {
    await s3Client.send(
      new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: s3Key }),
    );
    return true;
  } catch (error) {
    // AWS SDK v3 throws with name "NotFound" for a missing key — anything
    // else (permissions, network) should surface, not be swallowed as "missing".
    if ((error as { name?: string }).name === "NotFound") return false;
    throw error;
  }
}

export const getSignedReportUrl = getSignedImageUrl;
