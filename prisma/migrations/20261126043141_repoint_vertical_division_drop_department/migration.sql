/*
  Warnings:

  - You are about to drop the column `departmentId` on the `Vertical` table. All the data in the column will be lost.
  - You are about to drop the `Department` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[name,divisionId]` on the table `Vertical` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `divisionId` to the `Vertical` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "EventProposal" DROP CONSTRAINT "EventProposal_department_id_fkey";

-- DropForeignKey
ALTER TABLE "Vertical" DROP CONSTRAINT "Vertical_departmentId_fkey";

-- AlterTable
ALTER TABLE "Vertical" DROP COLUMN "departmentId",
ADD COLUMN     "divisionId" TEXT NOT NULL,
ALTER COLUMN "code" DROP NOT NULL;

-- DropTable
DROP TABLE "Department";

-- CreateIndex
CREATE UNIQUE INDEX "Vertical_name_divisionId_key" ON "Vertical"("name", "divisionId");

-- AddForeignKey
ALTER TABLE "EventProposal" ADD CONSTRAINT "EventProposal_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "Division"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vertical" ADD CONSTRAINT "Vertical_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE CASCADE ON UPDATE CASCADE;
