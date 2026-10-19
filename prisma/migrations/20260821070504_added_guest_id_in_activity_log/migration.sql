-- DropForeignKey
ALTER TABLE "ActivityLog" DROP CONSTRAINT "ActivityLog_actorId_fkey";

-- AlterTable
ALTER TABLE "ActivityLog" ADD COLUMN     "actorGuestId" TEXT,
ALTER COLUMN "actorId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "ActivityLog_actorGuestId_idx" ON "ActivityLog"("actorGuestId");

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_actorGuestId_fkey" FOREIGN KEY ("actorGuestId") REFERENCES "Guest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
