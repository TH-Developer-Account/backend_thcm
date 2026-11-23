/*
  Warnings:

  - A unique constraint covering the columns `[mobile]` on the table `MedicalClaim` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[email]` on the table `MedicalClaim` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[ticketNumber]` on the table `MedicalClaim` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "MedicalClaim_mobile_key" ON "MedicalClaim"("mobile");

-- CreateIndex
CREATE UNIQUE INDEX "MedicalClaim_email_key" ON "MedicalClaim"("email");

-- CreateIndex
CREATE UNIQUE INDEX "MedicalClaim_ticketNumber_key" ON "MedicalClaim"("ticketNumber");
