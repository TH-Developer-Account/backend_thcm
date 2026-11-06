/*
  Warnings:

  - You are about to drop the `AuthorityLimit` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `AuthorityLimitAssignment` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "AuthorityLimitAssignment" DROP CONSTRAINT "AuthorityLimitAssignment_authorityLimitId_fkey";

-- DropForeignKey
ALTER TABLE "AuthorityLimitAssignment" DROP CONSTRAINT "AuthorityLimitAssignment_designationId_fkey";

-- DropTable
DROP TABLE "AuthorityLimit";

-- DropTable
DROP TABLE "AuthorityLimitAssignment";

-- DropEnum
DROP TYPE "AuthorityRole";
