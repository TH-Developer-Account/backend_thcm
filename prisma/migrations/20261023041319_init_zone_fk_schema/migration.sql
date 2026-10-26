/*
  Warnings:

  - You are about to drop the column `designation` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `region` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `zone` on the `User` table. All the data in the column will be lost.
  - You are about to drop the `Region` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "EventProposal" DROP CONSTRAINT "EventProposal_region_id_fkey";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "designation",
DROP COLUMN "region",
DROP COLUMN "zone",
ADD COLUMN     "costCenterId" TEXT,
ADD COLUMN     "designationId" TEXT,
ADD COLUMN     "divisionId" TEXT,
ADD COLUMN     "locationId" TEXT;

-- DropTable
DROP TABLE "Region";

-- CreateTable
CREATE TABLE "Zone" (
    "id" TEXT NOT NULL,
    "region_code" TEXT NOT NULL,
    "region_name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Zone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRegion" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserRegion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_UserToZone" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_UserToZone_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "Zone_region_code_key" ON "Zone"("region_code");

-- CreateIndex
CREATE UNIQUE INDEX "UserRegion_name_key" ON "UserRegion"("name");

-- CreateIndex
CREATE INDEX "_UserToZone_B_index" ON "_UserToZone"("B");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "UserRegion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_designationId_fkey" FOREIGN KEY ("designationId") REFERENCES "Designation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_costCenterId_fkey" FOREIGN KEY ("costCenterId") REFERENCES "CostCenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventProposal" ADD CONSTRAINT "EventProposal_region_id_fkey" FOREIGN KEY ("region_id") REFERENCES "Zone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_UserToZone" ADD CONSTRAINT "_UserToZone_A_fkey" FOREIGN KEY ("A") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_UserToZone" ADD CONSTRAINT "_UserToZone_B_fkey" FOREIGN KEY ("B") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;
