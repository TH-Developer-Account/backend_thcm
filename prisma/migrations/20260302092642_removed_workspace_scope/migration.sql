-- Step 1: Delete all WORKSPACE-scoped rows (moduleId is null on these)
DELETE FROM "ProfilePermission" WHERE "moduleId" IS NULL;

-- Step 2: Drop the scopeType column
ALTER TABLE "ProfilePermission" DROP COLUMN "scopeType";

-- Step 3: Drop the now-unused ScopeType enum
DROP TYPE "ScopeType";

-- Step 4: Make moduleId NOT NULL now that nulls are gone
ALTER TABLE "ProfilePermission" ALTER COLUMN "moduleId" SET NOT NULL;

-- Step 5: Recreate the unique index without scopeType
DROP INDEX IF EXISTS "ProfilePermission_profileId_action_scopeType_moduleId_key";
CREATE UNIQUE INDEX "ProfilePermission_profileId_action_moduleId_key" 
  ON "ProfilePermission"("profileId", "action", "moduleId");