/**
 * Shared parsing helpers for the one-off data-migration scripts under
 * src/scripts/. Extracted here once updateUserHrData.ts and
 * backfillHrMasters.ts both needed the exact same functions — previously
 * this logic was copy-pasted into every import script (importUserMaster.ts,
 * importSimpleUsers.ts, importBusinessPartners.ts); those three are
 * untouched for now (not this task's scope), but any new script should
 * import from here rather than add a fifth copy.
 */

/**
 * Source files use several placeholder markers for "no value", not just
 * blank cells: "#" everywhere, "Not assigned" in C4C/dealer-style columns,
 * and a pair of wrapping double-quotes in EOR (it wraps any field
 * containing a comma in literal quote characters even though the file is
 * tab-delimited — a leftover CSV-export habit).
 */
export function toNullableString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  let str = String(value).trim();
  if (str.startsWith('"') && str.endsWith('"') && str.length >= 2) {
    str = str.slice(1, -1).trim();
  }
  if (str === "" || str === "#") return undefined;
  if (str.toLowerCase() === "not assigned") return undefined;
  return str;
}

/**
 * Strip to digits/leading-+ and reject anything that doesn't look like a
 * plausible phone number, rather than pass raw text through and risk Prisma
 * rejecting the whole row on a column-length error.
 */
export function sanitizePhoneNumber(value: unknown): string | undefined {
  const raw = toNullableString(value);
  if (!raw) return undefined;
  const cleaned = raw.replace(/[^\d+]/g, "");
  const digitCount = cleaned.replace(/\D/g, "").length;
  if (digitCount < 7 || digitCount > 15) return undefined; // not a plausible phone number
  return cleaned;
}

/**
 * Collapses a free-text value to a comparison key: trim, collapse internal
 * whitespace, uppercase. Used to treat "Asst Engineer" and "ASST   ENGINEER"
 * as the same designation/division without being fooled by case or stray
 * spacing — never used as the stored display value, only as a dedupe key.
 */
export function normalizeKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

/** Same collapsing as normalizeKey, but case-preserving — for display. */
export function cleanDisplayValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
