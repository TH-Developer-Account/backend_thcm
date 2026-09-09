/*
  Warnings:

  - The values [EPC_DELETED,EPF_SUBMITTED,CRF_SUBMITTED] on the enum `ActivityAction` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "ActivityAction_new" AS ENUM ('EPC_CREATED', 'EPC_UPDATED', 'EPF_CREATED', 'EPF_UPDATED', 'CRF_CREATED', 'CRF_UPDATED', 'EPC_RESUBMITTED', 'APPROVED', 'REJECTED', 'CLARIFY', 'DEVIATION_RAISED');
ALTER TABLE "ActivityLog" ALTER COLUMN "action" TYPE "ActivityAction_new" USING ("action"::text::"ActivityAction_new");
ALTER TYPE "ActivityAction" RENAME TO "ActivityAction_old";
ALTER TYPE "ActivityAction_new" RENAME TO "ActivityAction";
DROP TYPE "public"."ActivityAction_old";
COMMIT;
