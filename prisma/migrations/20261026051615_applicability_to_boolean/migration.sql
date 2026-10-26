-- Convert text ("Applicable" | "N/A" | NULL) to boolean (true | false | NULL), keeping data.
ALTER TABLE "VendorOnboarding"
  ALTER COLUMN "gstApplicability" TYPE BOOLEAN
    USING (CASE WHEN "gstApplicability" = 'N/A' THEN FALSE
                WHEN "gstApplicability" = 'Applicable' THEN TRUE ELSE NULL END),
  ALTER COLUMN "incorporationApplicability" TYPE BOOLEAN
    USING (CASE WHEN "incorporationApplicability" = 'N/A' THEN FALSE
                WHEN "incorporationApplicability" = 'Applicable' THEN TRUE ELSE NULL END);
