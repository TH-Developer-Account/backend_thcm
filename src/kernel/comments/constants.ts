// Proposer domain
export const EPC_CREATED = "EPC_CREATED";
export const EPC_UPDATED = "EPC_UPDATED";
export const EPF_CREATED = "EPF_CREATED";
export const EPF_UPDATED = "EPF_UPDATED";
export const CRF_CREATED = "CRF_CREATED";
export const CRF_UPDATED = "CRF_UPDATED";
export const EPC_RESUBMITTED = "EPC_RESUBMITTED"; // after a CLARIFY round

// Post-event domain
export const EPC_CONDUCTED = "EPC_CONDUCTED"; // proposer marks event as happened
export const EPC_CANCELLED = "EPC_CANCELLED"; // proposer cancels event after approval
export const REPORT_SUBMITTED = "REPORT_SUBMITTED"; // proposer submits PDF report
export const REPORT_RESUBMITTED = "REPORT_RESUBMITTED"; // proposer resubmits after rejection
export const REPORT_VALIDATED = "REPORT_VALIDATED"; // validator approves report
export const REPORT_REJECTED = "REPORT_REJECTED"; // validator rejects report
export const REPORT_CLARIFICATION_REQUESTED = "REPORT_CLARIFICATION_REQUESTED"; // validator requests clarification on report
export const EPC_CLOSED = "EPC_CLOSED"; // proposer closes after validation or deviation approval

// Vendor Onboarding
export const VENDOR_ONBOARDING_INITIATED = "VENDOR_ONBOARDING_INITIATED";
export const VENDOR_FORM_SUBMITTED = "VENDOR_FORM_SUBMITTED";
export const VENDOR_ONBOARDING_SENT_FOR_APPROVAL =
  "VENDOR_ONBOARDING_SENT_FOR_APPROVAL";
export const VENDOR_ONBOARDING_CLOSED = "VENDOR_ONBOARDING_CLOSED";

// Medical Claim
export const MEDICAL_CLAIM_INITIATED = "MEDICAL_CLAIM_INITIATED";
export const MEDICAL_CLAIM_SUBMITTED = "MEDICAL_CLAIM_SUBMITTED";
export const MEDICAL_CLAIM_RESUBMITTED = "MEDICAL_CLAIM_RESUBMITTED";
export const MEDICAL_CLAIM_SENT_FOR_APPROVAL =
  "MEDICAL_CLAIM_SENT_FOR_APPROVAL";
export const MEDICAL_CLAIM_CLOSED = "MEDICAL_CLAIM_CLOSED";

// Approval/workflow domain
export const APPROVED = "APPROVED";
export const REJECTED = "REJECTED";
export const CLARIFY = "CLARIFY";
export const DEVIATION_RAISED = "DEVIATION_RAISED";
