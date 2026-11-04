-- Plain nullable booleans: true = applicable, false = N/A, NULL = not chosen.
ALTER TABLE "VendorOnboarding"
  ADD COLUMN IF NOT EXISTS "gstApplicability" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "incorporationApplicability" BOOLEAN;