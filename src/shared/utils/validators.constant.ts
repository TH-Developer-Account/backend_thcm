// ─────────────────────────────────────────────────────────────────────────────
// APP VALIDATORS
//
// Maps each App key to the UUID of the user responsible for validating
// event reports submitted under that app.
//
// This is intentionally a compile-time constant rather than a DB row because:
//   - The validator per app changes extremely rarely
//   - It avoids an extra DB lookup on every report validation request
//   - Different environments (dev/staging/prod) will have different UUIDs,
//     so load the UUID from an env var — never commit a real UUID here.
//
// Setup:
//   Add to your .env:
//     MAP_VALIDATOR_ID=your-validator-user-uuid
//
// To add a new app validator, add a new env var and a new entry below.
// ─────────────────────────────────────────────────────────────────────────────

export const APP_VALIDATORS: Record<string, string> = {
  MAP: process.env.MAP_VALIDATOR_ID || "",
};

// ─────────────────────────────────────────────────────────────────────────────
// Resolves the validator UUID for a given app key.
// Throws at call-time (not at boot) so misconfiguration surfaces clearly
// in the response rather than crashing the server on startup.
// ─────────────────────────────────────────────────────────────────────────────

export function getValidatorForApp(appKey: string): string {
  const validatorId = APP_VALIDATORS[appKey];

  if (!validatorId) {
    return "";
  }

  return validatorId;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

export const REQUIRED_IMAGE_COUNT = 4;
export const VALID_IMAGE_POSITIONS = [1, 2, 3, 4] as const;
export const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
export const ALLOWED_VENDOR_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

export const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_VENDOR_DOCUMENT_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
