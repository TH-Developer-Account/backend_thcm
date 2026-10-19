-- AlterTable
ALTER TABLE "User" ADD COLUMN     "address" TEXT,
ADD COLUMN     "branch" TEXT,
ADD COLUMN     "businessPartnerId" TEXT,
ADD COLUMN     "bydId" TEXT,
ADD COLUMN     "c4cId" TEXT,
ADD COLUMN     "department" TEXT,
ADD COLUMN     "designation" TEXT,
ADD COLUMN     "employeeCode" TEXT,
ADD COLUMN     "isDefaultContact" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "joinedOn" TIMESTAMP(3),
ADD COLUMN     "managerCode1" TEXT,
ADD COLUMN     "managerCode2" TEXT,
ADD COLUMN     "region" TEXT,
ADD COLUMN     "role" TEXT,
ADD COLUMN     "s4Id" TEXT,
ADD COLUMN     "tallyId" TEXT,
ADD COLUMN     "userType" TEXT,
ADD COLUMN     "vertical" TEXT,
ADD COLUMN     "zone" TEXT,
ALTER COLUMN "email" DROP NOT NULL,
ALTER COLUMN "phone_number" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "User_employeeCode_userType_idx" ON "User"("employeeCode", "userType");

-- CreateIndex
CREATE INDEX "User_businessPartnerId_idx" ON "User"("businessPartnerId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_businessPartnerId_fkey" FOREIGN KEY ("businessPartnerId") REFERENCES "BusinessPartner"("id") ON DELETE SET NULL ON UPDATE CASCADE;
