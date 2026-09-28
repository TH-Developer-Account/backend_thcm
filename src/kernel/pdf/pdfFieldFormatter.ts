import type { PendingOn } from "@workflow/workflowSubject.helper";

// ─────────────────────────────────────────────────────────────────────────────
// PDF FIELD FORMATTERS
//
// Shared display rules so every docDefinition builder renders empty/boolean
// fields the same way. Pure functions — no pdfmake rendering knowledge.
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

// ─────────────────────────────────────────────────────────────────────────────
// displayPendingOn
//
// Turns the structured PendingOn result (@workflow/workflowSubject.helper —
// the same computePendingOn/resolveVendorOnboardingPendingOn/
// resolveMedicalClaimPendingOn output the listing/detail endpoints already
// use) into the printed status line. The "who is this pending on" logic
// itself is never reimplemented here — this only decides how to word it.
//
// Lives alongside the other display formatters (not inside a single
// docDefinition file) because PendingOn is shared across subject types
// (Vendor Onboarding, Medical Claim, ...) — any future internal-copy PDF
// for those can reuse this one formatter instead of growing its own.
// ─────────────────────────────────────────────────────────────────────────────

export function displayPendingOn(pendingOn: PendingOn): string {
	switch (pendingOn.role) {
		case "NONE":
			return pendingOn.outcome === "APPROVED" ? "Approved" : "Rejected";
		case "PROPOSER":
			return "Pending — Awaiting Employee Review";
		case "VENDOR":
			return "Pending with Vendor";
		case "GUEST":
			return "Pending with Ex-Employee";
		case "APPROVER":
			return pendingOn.approvers.length > 0
				? `Pending with ${pendingOn.approvers.map((a) => a.name).join(", ")}`
				: "Pending Approval";
		default:
			// Defensive fallback only — every PendingOn role above is handled;
			// this guards against a future role being added to the union without
			// this switch being updated.
			return "—";
	}
}

// Timezone used when printing timestamps. Change if your server/users differ.
const PDF_TIME_ZONE = "Asia/Kolkata";

// dd/mm/yyyy hh:mm:ss (24-hour). Returns "—" for empty or invalid input.
export function formatDateTimeSlash(
	value: Date | string | null | undefined,
): string {
	if (!value) return "—";
	const d = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(d.getTime())) return "—";

	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: PDF_TIME_ZONE,
		day: "2-digit",
		month: "2-digit",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).formatToParts(d);

	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
	return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}:${get("second")}`;
}
