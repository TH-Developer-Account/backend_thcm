-- CreateEnum
CREATE TYPE "AuthorityRole" AS ENUM ('PROPOSER', 'CHECKER', 'APPROVER');

-- CreateTable
CREATE TABLE "AuthorityLimit" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "minAmount" DECIMAL(12,2) NOT NULL,
    "maxAmount" DECIMAL(12,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthorityLimit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthorityLimitAssignment" (
    "id" TEXT NOT NULL,
    "authorityLimitId" TEXT NOT NULL,
    "role" "AuthorityRole" NOT NULL,
    "designationId" TEXT NOT NULL,

    CONSTRAINT "AuthorityLimitAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuthorityLimit_minAmount_maxAmount_idx" ON "AuthorityLimit"("minAmount", "maxAmount");

-- CreateIndex
CREATE INDEX "AuthorityLimitAssignment_designationId_role_idx" ON "AuthorityLimitAssignment"("designationId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "AuthorityLimitAssignment_authorityLimitId_role_designationI_key" ON "AuthorityLimitAssignment"("authorityLimitId", "role", "designationId");

-- AddForeignKey
ALTER TABLE "AuthorityLimitAssignment" ADD CONSTRAINT "AuthorityLimitAssignment_authorityLimitId_fkey" FOREIGN KEY ("authorityLimitId") REFERENCES "AuthorityLimit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthorityLimitAssignment" ADD CONSTRAINT "AuthorityLimitAssignment_designationId_fkey" FOREIGN KEY ("designationId") REFERENCES "Designation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
