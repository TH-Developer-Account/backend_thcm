/*
  Warnings:

  - The values [AUDIT_INSTANCE] on the enum `WorkflowSubjectType` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "WorkflowSubjectType_new" AS ENUM ('EVENT_PROPOSAL', 'VENDOR_ONBOARDING');
ALTER TABLE "WorkflowInstance" ALTER COLUMN "subjectType" TYPE "WorkflowSubjectType_new" USING ("subjectType"::text::"WorkflowSubjectType_new");
ALTER TABLE "ActivityLog" ALTER COLUMN "subjectType" TYPE "WorkflowSubjectType_new" USING ("subjectType"::text::"WorkflowSubjectType_new");
ALTER TYPE "WorkflowSubjectType" RENAME TO "WorkflowSubjectType_old";
ALTER TYPE "WorkflowSubjectType_new" RENAME TO "WorkflowSubjectType";
DROP TYPE "public"."WorkflowSubjectType_old";
COMMIT;
