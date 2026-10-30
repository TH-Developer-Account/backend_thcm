/*
  Warnings:

  - The primary key for the `Machine` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `serialNumber` on the `Machine` table. All the data in the column will be lost.
  - The primary key for the `MachineTelemetry` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `machineId` on the `MachineTelemetry` table. All the data in the column will be lost.
  - Added the required column `machineSerialNumber` to the `Machine` table without a default value. This is not possible if the table is not empty.
  - Added the required column `machineSerialNumber` to the `MachineTelemetry` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "MachineTelemetry" DROP CONSTRAINT "MachineTelemetry_machineId_fkey";

-- DropIndex
DROP INDEX "Machine_serialNumber_key";

-- DropIndex
DROP INDEX "MachineTelemetry_machineId_syncedAt_idx";

-- AlterTable
ALTER TABLE "Machine" DROP CONSTRAINT "Machine_pkey",
DROP COLUMN "serialNumber",
ADD COLUMN     "machineSerialNumber" TEXT NOT NULL,
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ADD CONSTRAINT "Machine_pkey" PRIMARY KEY ("machineSerialNumber");
DROP SEQUENCE "Machine_id_seq";

-- AlterTable
ALTER TABLE "MachineTelemetry" DROP CONSTRAINT "MachineTelemetry_pkey",
DROP COLUMN "machineId",
ADD COLUMN     "machineSerialNumber" TEXT NOT NULL,
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ADD CONSTRAINT "MachineTelemetry_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "MachineTelemetry_id_seq";

-- CreateIndex
CREATE INDEX "MachineTelemetry_machineSerialNumber_syncedAt_idx" ON "MachineTelemetry"("machineSerialNumber", "syncedAt");

-- AddForeignKey
ALTER TABLE "MachineTelemetry" ADD CONSTRAINT "MachineTelemetry_machineSerialNumber_fkey" FOREIGN KEY ("machineSerialNumber") REFERENCES "Machine"("machineSerialNumber") ON DELETE RESTRICT ON UPDATE CASCADE;
