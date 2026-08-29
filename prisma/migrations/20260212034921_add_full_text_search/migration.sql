/* -----------------------------------------------------
   1️⃣ Add search_vector column (if not exists)
----------------------------------------------------- */
ALTER TABLE "EventProposal"
ADD COLUMN IF NOT EXISTS search_vector tsvector;

