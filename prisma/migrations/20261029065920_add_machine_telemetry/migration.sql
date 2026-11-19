-- CreateTable
CREATE TABLE "Machine" (
    "id" SERIAL NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "customerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Machine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MachineTelemetry" (
    "id" SERIAL NOT NULL,
    "machineId" INTEGER NOT NULL,
    "latitude" DECIMAL(65,30) NOT NULL,
    "longitude" DECIMAL(65,30) NOT NULL,
    "hmr" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MachineTelemetry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Machine_serialNumber_key" ON "Machine"("serialNumber");

-- CreateIndex
CREATE INDEX "MachineTelemetry_machineId_syncedAt_idx" ON "MachineTelemetry"("machineId", "syncedAt");

-- AddForeignKey
ALTER TABLE "MachineTelemetry" ADD CONSTRAINT "MachineTelemetry_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
