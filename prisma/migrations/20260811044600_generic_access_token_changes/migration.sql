/*
  Warnings:

  - You are about to drop the `VendorAccessToken` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "AccessTokenSubjectType" AS ENUM ('VENDOR_ONBOARDING', 'MEDICAL_CLAIM');

-- DropForeignKey
ALTER TABLE "VendorAccessToken" DROP CONSTRAINT "VendorAccessToken_onboardingId_fkey";

-- DropTable
DROP TABLE "VendorAccessToken";

-- DropEnum
DROP TYPE "VendorAccessTokenPurpose";

-- CreateTable
CREATE TABLE "AccessToken" (
    "id" TEXT NOT NULL,
    "subjectType" "AccessTokenSubjectType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "purpose" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccessToken_token_key" ON "AccessToken"("token");

-- CreateIndex
CREATE INDEX "AccessToken_subjectType_subjectId_idx" ON "AccessToken"("subjectType", "subjectId");
