/*
  Warnings:

  - You are about to drop the column `event_scale_id` on the `EventProposal` table. All the data in the column will be lost.
  - You are about to drop the `EventScale` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `event_scale` to the `EventProposal` table without a default value. This is not possible if the table is not empty.
  - Added the required column `vertical_id` to the `EventProposal` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "EventProposal" DROP CONSTRAINT "EventProposal_event_scale_id_fkey";

-- AlterTable
ALTER TABLE "EventProposal" DROP COLUMN "event_scale_id",
ADD COLUMN     "event_scale" INTEGER NOT NULL,
ADD COLUMN     "vertical_id" TEXT NOT NULL;

-- DropTable
DROP TABLE "EventScale";

-- CreateTable
CREATE TABLE "Vertical" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "departmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vertical_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Vertical_code_key" ON "Vertical"("code");

-- AddForeignKey
ALTER TABLE "EventProposal" ADD CONSTRAINT "EventProposal_vertical_id_fkey" FOREIGN KEY ("vertical_id") REFERENCES "Vertical"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vertical" ADD CONSTRAINT "Vertical_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
