-- AlterTable
ALTER TABLE "Machine" ADD COLUMN     "isConsiteMachine" BOOLEAN,
ADD COLUMN     "isKeyAccount" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "MachineTelemetry" ADD COLUMN     "dailyOperationHrs" DECIMAL(65,30);

-- CreateIndex
CREATE INDEX "Machine_isKeyAccount_idx" ON "Machine"("isKeyAccount");
