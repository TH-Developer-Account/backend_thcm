// ─────────────────────────────────────────────────────────────────────────────
// PDF FIELD FORMATTERS
//
// Shared display rules so every docDefinition builder renders empty/boolean
// fields the same way. Pure functions — no pdfmake or domain knowledge.
// ─────────────────────────────────────────────────────────────────────────────

export function displayValue(
  value: string | number | null | undefined,
): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

export function displayBoolean(value: boolean | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value ? "Yes" : "No";
}

export function displayDate(value: Date | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}
