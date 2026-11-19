-- DropForeignKey
ALTER TABLE "Vertical" DROP CONSTRAINT "Vertical_departmentId_fkey";

-- AddForeignKey
ALTER TABLE "Vertical" ADD CONSTRAINT "Vertical_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;
