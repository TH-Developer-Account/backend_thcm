/*
  Warnings:

  - You are about to drop the `MedicalClaimGradeEligibility` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE "MedicalClaimGradeEligibility";

-- CreateTable
CREATE TABLE "GradeEligibility" (
    "id" TEXT NOT NULL,
    "grade" TEXT NOT NULL,
    "annualCap" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "GradeEligibility_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GradeEligibility_grade_key" ON "GradeEligibility"("grade");
