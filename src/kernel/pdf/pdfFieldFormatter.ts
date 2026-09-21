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

// Same date rendering as displayDate, with time down to the second appended.
// Kept as a separate function rather than a parameter on displayDate so
// existing callers (e.g. Medical Claim's docDefinition) keep their current
// date-only output — this is opt-in for fields that need proof of exact
// submission time, such as a document's upload timestamp.
export function displayDateTime(value: Date | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return `${displayDate(date)}, ${date.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  })}`;
}
