/*
  Warnings:

  - You are about to drop the column `maxBudget` on the `WorkflowTemplate` table. All the data in the column will be lost.
  - You are about to drop the column `minBudget` on the `WorkflowTemplate` table. All the data in the column will be lost.
  - You are about to drop the column `regionId` on the `WorkflowTemplate` table. All the data in the column will be lost.
  - Added the required column `appId` to the `WorkflowTemplate` table without a default value. This is not possible if the table is not empty.
  - Added the required column `metaData_1` to the `WorkflowTemplate` table without a default value. This is not possible if the table is not empty.
  - Added the required column `metaData_2` to the `WorkflowTemplate` table without a default value. This is not possible if the table is not empty.
  - Added the required column `metaData_3` to the `WorkflowTemplate` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "WorkflowTemplate" DROP CONSTRAINT "WorkflowTemplate_regionId_fkey";

-- AlterTable
ALTER TABLE "WorkflowTemplate" DROP COLUMN "maxBudget",
DROP COLUMN "minBudget",
DROP COLUMN "regionId",
ADD COLUMN     "appId" TEXT NOT NULL,
ADD COLUMN     "metaData_1" TEXT NOT NULL,
ADD COLUMN     "metaData_2" TEXT NOT NULL,
ADD COLUMN     "metaData_3" TEXT NOT NULL;

-- AddForeignKey
ALTER TABLE "WorkflowTemplate" ADD CONSTRAINT "WorkflowTemplate_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
