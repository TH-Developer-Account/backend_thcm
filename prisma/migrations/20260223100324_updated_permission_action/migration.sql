/*
  Warnings:

  - The values [create,update,delete,approve,export] on the enum `PermissionAction` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "PermissionAction_new" AS ENUM ('read', 'write');
ALTER TABLE "ProfilePermission" ALTER COLUMN "permission" TYPE "PermissionAction_new" USING ("permission"::text::"PermissionAction_new");
ALTER TYPE "PermissionAction" RENAME TO "PermissionAction_old";
ALTER TYPE "PermissionAction_new" RENAME TO "PermissionAction";
DROP TYPE "public"."PermissionAction_old";
COMMIT;
