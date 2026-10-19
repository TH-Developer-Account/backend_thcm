-- DropForeignKey
ALTER TABLE "Approval" DROP CONSTRAINT "Approval_stageId_fkey";

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "StageInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
