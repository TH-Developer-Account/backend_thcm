// ─────────────────────────────────────────────────────────────────────────────
// Classifies a machine serial number as ConSite or InSite.
//
// Rule (as given): a ConSite machine's serial number contains one of a
// known set of model codes (e.g. "DEKL0", "JAHL0", "0ACH") — confirmed
// against every sample in the "Model Code → Machine Model → Example Sl. No"
// table, regardless of the prefix in front of it (THE/HCM/BAN/none).
//
// Deliberately a plain `includes` check, not anchored to a prefix — this
// was a conscious choice (not an oversight): confirmed to proceed with the
// simpler rule even though short codes like "18K"/"18U"/"0ACH" carry some
// false-positive risk against an unrelated serial that happens to contain
// that substring elsewhere. If misclassifications show up in practice,
// this is the one function to revisit.
//
// Hardcoded rather than a DB master table — confirmed as the complete list
// for now. If Hitachi adds new model codes later, this array is the only
// place that needs updating (and a re-run of
// scripts/classifyMachineTelematicsSource.ts to pick up the change for
// existing machines).
// ─────────────────────────────────────────────────────────────────────────────

export const CONSITE_MODEL_CODES: string[] = [
  "DEKL0",
  "DHJL0",
  "DA0L0",
  "DCDL0",
  "DCRD0",
  "DCRL0",
  "DC0L0",
  "DD1L0",
  "DD1L1",
  "DDKL0",
  "0ACH",
  "0OACE",
  "JAHL0",
  "JAEL0",
  "JAELZ",
  "JBE92",
  "JBEL0",
  "JB293",
  "18K",
  "KBC90",
  "KEA91",
  "KBB91",
  "18U",
  "QEA90",
  "NHF90",
  "NFC90",
];

// Returns true if the given serial number should be treated as a ConSite
// machine. A null/empty serial number is never ConSite — callers should
// treat that as "unclassifiable" rather than calling this at all.
export function isConsiteSerial(serialNumber: string): boolean {
  return CONSITE_MODEL_CODES.some((code) => serialNumber.includes(code));
}
