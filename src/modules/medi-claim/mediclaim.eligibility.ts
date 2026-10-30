import legacyData from "./legacyBalances.json";

// ─────────────────────────────────────────────────────────────────────────────
// mediclaim.eligibility.ts
//
// PURE eligibility rules for the medical reimbursement module — no DB, no
// Prisma, no Express. Everything that decides "how much can this retiree still
// claim" lives here so it can be unit-tested with plain objects; the DB-facing
// wrappers are in mediclaim.helper.ts.
//
// THE RULES (confirmed with product):
//   • Two separate buckets per retiree, per financial year (Apr–Mar):
//       – NON-HOSPITALISATION ("domiciliary")  → GradeEligibility.annualCap
//             EG grades 75,000 · TM grades 30,000 · TS-2 25,000
//       – HOSPITALISATION (EG grades only)      → HOSPITALISATION_ANNUAL_CAP
//             1,25,000, a constant (same for every EG grade)
//     EG total cover = 75,000 + 1,25,000 = 2,00,000. The buckets never borrow
//     from each other.
//   • A bill counts as hospitalisation iff its claimHead is
//     EXCESS_HOSPITALISATION; every other head is non-hospitalisation.
//   • Used = settled (APPROVED / CLOSED claims) + the FY26-27 legacy balance.
//     Held = submitted-but-unsettled claims (IN_PROGRESS / CLARIFICATION).
//   • Settled amount of a bill = approvedClaimAmount. If the approver just
//     approved the line (no amount typed) the claimed amount IS the approved
//     amount — so a null approvedClaimAmount on a settled claim counts at the
//     full claimed amount, never as 0.
//
// All arithmetic is done in integer PAISE and converted to rupees once at the
// end, so 17,754.42 + 1,338.50 can never drift by a fraction of a paisa.
// ─────────────────────────────────────────────────────────────────────────────

// ── constants ───────────────────────────────────────────────────────────────

/**
 * Which window "this year's" claims are counted over.
 *   true  → financial year (Apr–Mar) — what the process document describes.
 *   false → calendar year (Jan–Dec).
 * Mirrors MEDICLAIM_BACKEND.financialYearEligibility on the frontend: flip
 * BOTH together, otherwise the period label and the numbers disagree.
 */
export const FINANCIAL_YEAR_ELIGIBILITY = true;

/** Hospitalisation is tracked separately, under this existing claim head. */
export const HOSPITALISATION_CLAIM_HEAD = "EXCESS_HOSPITALISATION";

/** Hospitalisation cover for EG grades — ₹1.25 lakh per eligibility window. */
export const HOSPITALISATION_ANNUAL_CAP = 125_000;

/** Claims whose approved amounts count as already used. CLOSED = APPROVED + closed. */
export const SETTLED_CLAIM_STATUSES = ["APPROVED", "CLOSED"] as const;

/**
 * Submitted but not yet settled. Their amounts are held back so a second
 * claim can't spend the same money. Released if the claim is rejected, and
 * moves to "settled" once approved.
 */
export const HOLD_CLAIM_STATUSES = [
  "IN_PROGRESS",
  "CLARIFICATION_REQUESTED",
] as const;

/** Mirrors the ClaimHead enum in schema.prisma. */
export const CLAIM_HEADS = [
  "VISIT_FEES",
  "MEDICINES_INVESTIGATIONS",
  "OPHTHALMIC_TREATMENT",
  "EXECUTIVE_HEALTH_CHECKUP",
  "EXCESS_HOSPITALISATION",
] as const;

/**
 * The legacy sheet is the FY2026-27 (Apr 2026 – Mar 2027) history that
 * predates this system. It must only count inside that window — otherwise it
 * would leak into FY2027-28.
 */
export const LEGACY_BALANCE_FY_START_YEAR = 2026;

// ── normalisation ───────────────────────────────────────────────────────────

/** "EG-4  " / "eg-4" → "EG-4". HR data and the legacy sheet carry stray spaces. */
export const normalizeGrade = (grade?: string | null): string =>
  (grade ?? "").trim().replace(/\s+/g, " ").toUpperCase();

export const normalizeTicketNumber = (ticket?: string | null): string =>
  (ticket ?? "").trim().toUpperCase();

/** EG, EG-1A, EG-2A1 … — the only grades with hospitalisation cover. */
export const isHospitalisationGrade = (grade?: string | null): boolean =>
  /^EG(-|$)/.test(normalizeGrade(grade));

export const isHospitalisationHead = (claimHead: unknown): boolean =>
  String(claimHead) === HOSPITALISATION_CLAIM_HEAD;

// ── money ───────────────────────────────────────────────────────────────────

/** Rupees (number | Decimal | string) → integer paise. Non-finite → 0. */
export const toPaise = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
};

export const round2 = (value: number): number => Math.round(value * 100) / 100;

export const formatInr = (value: number): string =>
  `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

// ── eligibility window ──────────────────────────────────────────────────────

// India has no DST, so a fixed offset is exact. Boundaries are computed in IST
// so a claim submitted at 00:30 IST on 1 April lands in the NEW financial
// year even though the server clock (UTC) still says 31 March.
const IST_OFFSET_MS = 330 * 60 * 1000;

const istMonthStart = (year: number, monthIndex: number): Date =>
  new Date(Date.UTC(year, monthIndex, 1) - IST_OFFSET_MS);

export interface EligibilityWindow {
  /** Inclusive. */
  start: Date;
  /** Exclusive. */
  end: Date;
  /** FY start year (FY mode) or the calendar year. */
  startYear: number;
  /** e.g. "FY 2026-27" */
  label: string;
}

export function getEligibilityWindow(ref: Date = new Date()): EligibilityWindow {
  const ist = new Date(ref.getTime() + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();

  if (!FINANCIAL_YEAR_ELIGIBILITY) {
    return {
      start: istMonthStart(year, 0),
      end: istMonthStart(year + 1, 0),
      startYear: year,
      label: `Jan–Dec ${year}`,
    };
  }

  const startYear = ist.getUTCMonth() >= 3 ? year : year - 1;
  return {
    start: istMonthStart(startYear, 3),
    end: istMonthStart(startYear + 1, 3),
    startYear,
    label: `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`,
  };
}

export const getEligibilityWindowStart = (ref?: Date): Date =>
  getEligibilityWindow(ref).start;

// ── legacy balances ─────────────────────────────────────────────────────────
//
// One-time migration bridge for FY26-27 history that predates this system —
// ~77 retirees whose manual claim records were never entered here. Keyed by
// retiree code (e.g. "RE10214") — matched against MedicalClaim.ticketNumber.
//
// Each record carries the sheet's own split (hospitalisation vs
// non-hospitalisation), so nothing has to be guessed. `utilizedAmount` is the
// sheet's "Total" and equals the sum of the two.
//
// TODO: remove this file, legacyBalances.json and getLegacyPaise once the
// FY26-27 window has closed (after 31 Mar 2027) — it is ignored from then on
// anyway.

export type LegacyMediclaimRecord = {
  name: string | null;
  grade: string | null;
  utilizedAmount: number;
  nonHospitalisationAmount?: number;
  hospitalisationAmount?: number;
};

const legacyBalanceMap = new Map<string, LegacyMediclaimRecord>(
  Object.entries(legacyData as unknown as Record<string, LegacyMediclaimRecord>)
    .filter(([code]) => code !== "Grand Total")
    .map(([code, record]) => [normalizeTicketNumber(code), record]),
);

export function getLegacyMediclaimRecord(
  ticketNumber: string | null | undefined,
): LegacyMediclaimRecord | null {
  const key = normalizeTicketNumber(ticketNumber);
  return key ? (legacyBalanceMap.get(key) ?? null) : null;
}

export interface BucketsPaise {
  standard: number;
  hospitalisation: number;
}

/** Legacy used-amount in paise, split by bucket. Zero outside the legacy FY. */
export function getLegacyPaise(
  ticketNumber: string | null | undefined,
  window: EligibilityWindow,
): BucketsPaise {
  const none: BucketsPaise = { standard: 0, hospitalisation: 0 };
  if (window.startYear !== LEGACY_BALANCE_FY_START_YEAR) return none;

  const record = getLegacyMediclaimRecord(ticketNumber);
  if (!record) return none;

  const hasSplit =
    record.nonHospitalisationAmount != null ||
    record.hospitalisationAmount != null;

  return hasSplit
    ? {
        standard: toPaise(record.nonHospitalisationAmount),
        hospitalisation: toPaise(record.hospitalisationAmount),
      }
    : // Older JSON without the split: the sheet total is non-hospitalisation.
      { standard: toPaise(record.utilizedAmount), hospitalisation: 0 };
}

// ── claim history (settled vs held) ─────────────────────────────────────────

export interface ClaimHistoryPaise {
  settled: BucketsPaise;
  held: BucketsPaise;
}

export const emptyHistory = (): ClaimHistoryPaise => ({
  settled: { standard: 0, hospitalisation: 0 },
  held: { standard: 0, hospitalisation: 0 },
});

export interface HistoryBillRow {
  claimHead: unknown;
  amount: unknown;
  approved: boolean;
  approvedClaimAmount: unknown;
  /** Status of the claim the bill belongs to. */
  claimStatus: string;
}

/**
 * Amount of a bill that the approver accepted, in paise.
 *   • approvedClaimAmount set  → that amount (never above what was claimed)
 *   • approvedClaimAmount null → the approver just approved the line, so the
 *                                claimed amount IS the approved amount
 */
export function approvedPaise(bill: {
  amount: unknown;
  approvedClaimAmount: unknown;
}): number {
  const claimed = toPaise(bill.amount);
  if (bill.approvedClaimAmount === null || bill.approvedClaimAmount === undefined) {
    return claimed;
  }
  return Math.min(Math.max(toPaise(bill.approvedClaimAmount), 0), claimed);
}

/**
 * Folds bill rows into settled / held buckets.
 *
 *  settled — bills on APPROVED / CLOSED claims, at their approved amount
 *  held    — bills on IN_PROGRESS / CLARIFICATION_REQUESTED claims: the
 *            approved amount if the line is already approved, otherwise the
 *            claimed amount (money is reserved until the approver decides)
 */
export function sumBillsIntoHistory(rows: HistoryBillRow[]): ClaimHistoryPaise {
  const history = emptyHistory();

  for (const row of rows) {
    const bucket = isHospitalisationHead(row.claimHead)
      ? "hospitalisation"
      : "standard";
    const isSettled = (SETTLED_CLAIM_STATUSES as readonly string[]).includes(
      String(row.claimStatus),
    );

    if (isSettled) {
      history.settled[bucket] += approvedPaise(row);
    } else {
      history.held[bucket] += row.approved
        ? approvedPaise(row)
        : toPaise(row.amount);
    }
  }

  return history;
}

// ── eligibility ─────────────────────────────────────────────────────────────

export interface BucketEligibility {
  /** Cap for this bucket. */
  annualCap: number;
  /** cap − alreadySettled (holds NOT subtracted), floored at 0. */
  eligibleAmount: number;
  /** Used so far: settled claims (+ legacy balance). */
  alreadySettled: number;
  /** Held by this retiree's other submitted-but-unsettled claims. */
  inProgressAmount: number;
  /** cap − settled − held, floored at 0: what can still be claimed now. */
  availableAmount: number;
}

export interface MedicalClaimEligibility extends BucketEligibility {
  /** Non-hospitalisation cap + hospitalisation cap (EG: 2,00,000). */
  totalAnnualCap: number;
  /** null for non-EG grades — they have no hospitalisation cover. */
  hospitalisation: BucketEligibility | null;
  period: { label: string; start: string; end: string };
}

const makeBucket = (
  capPaise: number,
  settledPaise: number,
  heldPaise: number,
): BucketEligibility => ({
  annualCap: capPaise / 100,
  alreadySettled: settledPaise / 100,
  eligibleAmount: Math.max(capPaise - settledPaise, 0) / 100,
  inProgressAmount: heldPaise / 100,
  availableAmount: Math.max(capPaise - settledPaise - heldPaise, 0) / 100,
});

export function buildEligibility(input: {
  grade: string;
  /** GradeEligibility.annualCap — the NON-hospitalisation cap, in rupees. */
  standardCap: number;
  history: ClaimHistoryPaise;
  legacy: BucketsPaise;
  window: EligibilityWindow;
}): MedicalClaimEligibility {
  const { grade, standardCap, history, legacy, window } = input;

  const standardCapPaise = toPaise(standardCap);
  const standard = makeBucket(
    standardCapPaise,
    history.settled.standard + legacy.standard,
    history.held.standard,
  );

  const hospitalisationCapPaise = isHospitalisationGrade(grade)
    ? toPaise(HOSPITALISATION_ANNUAL_CAP)
    : null;

  const hospitalisation =
    hospitalisationCapPaise === null
      ? null
      : makeBucket(
          hospitalisationCapPaise,
          history.settled.hospitalisation + legacy.hospitalisation,
          history.held.hospitalisation,
        );

  return {
    ...standard,
    totalAnnualCap: (standardCapPaise + (hospitalisationCapPaise ?? 0)) / 100,
    hospitalisation,
    period: {
      label: window.label,
      start: window.start.toISOString(),
      end: window.end.toISOString(),
    },
  };
}

// ── submit / resubmit guard ─────────────────────────────────────────────────

export interface BillAmountInput {
  claimHead: unknown;
  amount: unknown;
}

/**
 * Checks a set of bills against the live eligibility. Returns an error message
 * for the first rule broken, or null when everything fits.
 *
 *  - hospitalisation bills need an EG grade
 *  - non-hospitalisation bills must fit in what's available after holds
 *  - hospitalisation bills must fit in the hospitalisation bucket
 */
export function evaluateBillsAgainstEligibility(
  bills: BillAmountInput[],
  grade: string,
  eligibility: MedicalClaimEligibility,
): string | null {
  let standard = 0;
  let hospitalisation = 0;
  for (const bill of bills) {
    if (isHospitalisationHead(bill.claimHead)) {
      hospitalisation += toPaise(bill.amount);
    } else {
      standard += toPaise(bill.amount);
    }
  }

  if (hospitalisation > 0 && !eligibility.hospitalisation) {
    return `Hospitalisation expenses are covered only for EG grades (grade "${grade}" is not eligible)`;
  }

  if (standard > toPaise(eligibility.availableAmount)) {
    const hold =
      eligibility.inProgressAmount > 0
        ? ` ${formatInr(eligibility.inProgressAmount)} of the limit is on hold for claims that are still in progress.`
        : "";
    return `Claimed total ${formatInr(standard / 100)} exceeds the ${formatInr(eligibility.availableAmount)} available.${hold}`;
  }

  if (
    eligibility.hospitalisation &&
    hospitalisation > toPaise(eligibility.hospitalisation.availableAmount)
  ) {
    const { availableAmount, inProgressAmount } = eligibility.hospitalisation;
    const hold =
      inProgressAmount > 0
        ? ` ${formatInr(inProgressAmount)} is on hold for hospitalisation claims that are still in progress.`
        : "";
    return `Hospitalisation total ${formatInr(hospitalisation / 100)} exceeds the ${formatInr(availableAmount)} available.${hold}`;
  }

  return null;
}
