-- DropIndex
DROP INDEX "MedicalClaim_email_key";

-- DropIndex
DROP INDEX "MedicalClaim_mobile_key";

-- DropIndex
DROP INDEX "MedicalClaim_ticketNumber_key";

-- AlterTable
ALTER TABLE "MedicalClaim" ADD COLUMN     "createdByGuest" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "MedicalClaim_ticketNumber_idx" ON "MedicalClaim"("ticketNumber");

-- CreateIndex
CREATE INDEX "MedicalClaim_mobile_idx" ON "MedicalClaim"("mobile");

-- CreateIndex
CREATE INDEX "MedicalClaim_email_idx" ON "MedicalClaim"("email");

-- "HR initiates a retiree once": unique only among HR-initiated claims
CREATE UNIQUE INDEX medclaim_initiated_once_ticket ON "MedicalClaim" ("ticketNumber")
  WHERE "createdByGuest" = false AND "ticketNumber" IS NOT NULL;
CREATE UNIQUE INDEX medclaim_initiated_once_mobile ON "MedicalClaim" (mobile)
  WHERE "createdByGuest" = false AND mobile IS NOT NULL;
CREATE UNIQUE INDEX medclaim_initiated_once_email ON "MedicalClaim" (email)
  WHERE "createdByGuest" = false AND email IS NOT NULL;