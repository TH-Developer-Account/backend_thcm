// modules/map/authorityLimit.helper.ts
//
// Schedule of Authority (SOA) eligibility — kept MAP-only and separate from
// the generic workflow engine, same reasoning that keeps AuthorityLimit off
// the Designation table (see schema.prisma's AuthorityLimit doc comment):
// this is MAP's own budget-gating policy, not a cross-app concern.
//
// `resolveAuthorityEligibilityForAmount` is the single source of truth for
// "can this designation create (PROPOSER) / auto-approve (APPROVER) this
// amount" — it knows nothing about EPCs at all. Three call sites share it
// so they can never drift apart:
//   - resolveEpcAuthorityEligibility (below): looks up a saved EPC's
//     persisted Tata Hitachi share, then delegates here. Used by
//     getAuthorityEligibility and the committing finalizeEventProposal.
//   - epc.controller.ts's checkAuthorityForAmount: calls this directly
//     with an amount the frontend hasn't saved anywhere yet (the live,
//     unsaved EPF form value) — lets the creator check their authority
//     BEFORE saving/submitting anything.
//
// APPROVER eligibility inherits upward across bands — a designation
// assigned APPROVER on a higher band is automatically eligible to APPROVE
// every lower band too (isApproverEligible).
//
// PROPOSER eligibility for a band is true if EITHER:
//   (a) an explicit PROPOSER assignment on that EXACT band, OR
//   (b) APPROVER-eligible for that band (isApproverEligible) — i.e. an
//       APPROVER assignment on that band OR ANY HIGHER one. Authority to
//       approve an amount necessarily includes authority to merely propose
//       it, so an approver of a higher band can propose (and will be
//       auto-approved, no workflow) in every lower band too, with no
//       separate PROPOSER row needed.
// A PROPOSER row on a band HIGHER than any band you approve still only
// grants (b) — proposing, never approving — for that higher band, so a
// workflow is still required there unless APPROVER-eligible on it too.
// Beyond both (a) and (b), there is no path at all: exceeding every band
// you can propose OR approve is a hard rejection, never an escalation to a
// workflow for an amount you weren't authorized to create in the first
// place. CHECKER is unused today (the checker stage is skipped) but the
// schema keeps the enum value for a future requirement.
import { prisma } from "@shared/config/prisma";
import { AuthorityRole } from "../../../prisma/generated/prisma/client";

export interface AuthorityLimitBand {
  id: string;
  label: string;
  minAmount: number;
  maxAmount: number | null;
}

// Finds the single active band whose [minAmount, maxAmount) range contains
// `amount`. Bands are expected not to overlap (enforced at write time by
// the admin controller's assertNoOverlap), so at most one should match —
// findFirst with an ascending orderBy is a defensive tie-break, not a
// correctness requirement.
export async function resolveApplicableAuthorityLimit(
  amount: number,
): Promise<AuthorityLimitBand | null> {
  const band = await prisma.authorityLimit.findFirst({
    where: {
      isActive: true,
      minAmount: { lte: amount },
      OR: [{ maxAmount: null }, { maxAmount: { gte: amount } }],
    },
    orderBy: { minAmount: "asc" },
    select: { id: true, label: true, minAmount: true, maxAmount: true },
  });

  if (!band) return null;

  return {
    id: band.id,
    label: band.label,
    minAmount: band.minAmount.toNumber(),
    maxAmount: band.maxAmount ? band.maxAmount.toNumber() : null,
  };
}

// Is `designationId` an eligible APPROVER for `limitId`'s band? Inherits
// upward: an assignment on any active band whose minAmount is >= the
// target band's minAmount also covers the target band.
export async function isApproverEligible(
  designationId: string,
  limitId: string,
): Promise<boolean> {
  const targetLimit = await prisma.authorityLimit.findUnique({
    where: { id: limitId },
    select: { minAmount: true },
  });
  if (!targetLimit) return false;

  const assignment = await prisma.authorityLimitAssignment.findFirst({
    where: {
      designationId,
      role: AuthorityRole.APPROVER,
      authorityLimit: {
        isActive: true,
        minAmount: { gte: targetLimit.minAmount },
      },
    },
    select: { id: true },
  });

  return Boolean(assignment);
}

// Is `designationId` an eligible PROPOSER for `limitId`'s band — i.e.
// authorized to even CREATE/submit an EPC whose Tata Hitachi share falls
// into this exact band? True if there's an explicit PROPOSER assignment on
// this EXACT band, OR the designation is APPROVER-eligible for it (see
// file header: approving a band — or any higher one — implies being
// allowed to propose it too). Deliberately reuses isApproverEligible
// rather than re-querying, so the two can never drift apart.
export async function isProposerEligible(
  designationId: string,
  limitId: string,
): Promise<boolean> {
  const [hasProposerAssignment, approverEligible] = await Promise.all([
    prisma.authorityLimitAssignment.findFirst({
      where: {
        designationId,
        role: AuthorityRole.PROPOSER,
        authorityLimit: { id: limitId, isActive: true },
      },
      select: { id: true },
    }),
    isApproverEligible(designationId, limitId),
  ]);

  return Boolean(hasProposerAssignment) || approverEligible;
}

export interface AuthorityEligibility {
  /** APPROVER-eligible → can auto-approve, no workflow needed. */
  eligible: boolean;
  /** PROPOSER-eligible → authorized to submit this amount at all. False
   *  here is a hard rejection, never a fall-back-to-workflow case. */
  proposerEligible: boolean;
  applicableLimit: AuthorityLimitBand | null;
}

// The EPC-agnostic core: given a user and a bare amount, what are they
// allowed to do? Doesn't care where `amount` came from or whether it's
// been saved anywhere — this is what lets the frontend check authority
// against a live, unsaved form value.
export async function resolveAuthorityEligibilityForAmount(
  userId: string,
  amount: number,
): Promise<AuthorityEligibility> {
  const [creator, applicableLimit] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { designationId: true },
    }),
    resolveApplicableAuthorityLimit(amount),
  ]);

  const hasDesignationAndBand =
    Boolean(creator?.designationId) && Boolean(applicableLimit);

  const [eligible, proposerEligible] = hasDesignationAndBand
    ? await Promise.all([
        isApproverEligible(creator!.designationId!, applicableLimit!.id),
        isProposerEligible(creator!.designationId!, applicableLimit!.id),
      ])
    : [false, false];

  return { eligible, proposerEligible, applicableLimit };
}

export interface EpcAuthorityEligibility extends AuthorityEligibility {
  tataHitachiPoAmount: number;
}

// EPC-bound convenience wrapper: loads the SAVED EPF.tataHitachiPoAmount
// for this EPC — the Tata Hitachi share only, dealer share excluded,
// because SOA authority is scoped to what Tata Hitachi itself is on the
// hook for — then delegates to resolveAuthorityEligibilityForAmount.
// Consumed by getAuthorityEligibility and the committing
// finalizeEventProposal, so the two can never drift apart.
export async function resolveEpcAuthorityEligibility(
  epcId: string,
  userId: string,
): Promise<EpcAuthorityEligibility> {
  const epc = await prisma.eventProposal.findUnique({
    where: { id: epcId },
    select: { epf: { select: { tataHitachiPoAmount: true } } },
  });

  const tataHitachiPoAmount = Number(epc?.epf?.tataHitachiPoAmount) || 0;

  const { eligible, proposerEligible, applicableLimit } =
    await resolveAuthorityEligibilityForAmount(userId, tataHitachiPoAmount);

  return { eligible, proposerEligible, applicableLimit, tataHitachiPoAmount };
}
