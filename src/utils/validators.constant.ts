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
  MAP: "5c61c004-c30b-41e9-b76b-a3dd5261a07b",
};

// ─────────────────────────────────────────────────────────────────────────────
// Resolves the validator UUID for a given app key.
// Throws at call-time (not at boot) so misconfiguration surfaces clearly
// in the response rather than crashing the server on startup.
// ─────────────────────────────────────────────────────────────────────────────

export function getValidatorForApp(appKey: string): string {
  const validatorId = APP_VALIDATORS[appKey];

  if (!validatorId) {
    throw new Error(
      `No validator configured for app "${appKey}". ` +
        `Set the corresponding env var (e.g. ${appKey}_VALIDATOR_ID) and restart.`,
    );
  }

  return validatorId;
}
