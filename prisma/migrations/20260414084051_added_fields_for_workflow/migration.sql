/*
  Warnings:

  - The values [QUORUM] on the enum `StrategyType` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `priority` on the `WorkflowTemplate` table. All the data in the column will be lost.
  - Added the required column `name` to the `TemplateStage` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updated_at` to the `WorkflowInstance` table without a default value. This is not possible if the table is not empty.
  - Added the required column `created_by_id` to the `WorkflowTemplate` table without a default value. This is not possible if the table is not empty.
  - Added the required column `description` to the `WorkflowTemplate` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updated_at` to the `WorkflowTemplate` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updated_by_id` to the `WorkflowTemplate` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "StrategyType_new" AS ENUM ('ALL', 'ANY', 'SOME');
ALTER TABLE "TemplateStage" ALTER COLUMN "strategy" TYPE "StrategyType_new" USING ("strategy"::text::"StrategyType_new");
ALTER TABLE "StageInstance" ALTER COLUMN "strategy" TYPE "StrategyType_new" USING ("strategy"::text::"StrategyType_new");
ALTER TYPE "StrategyType" RENAME TO "StrategyType_old";
ALTER TYPE "StrategyType_new" RENAME TO "StrategyType";
DROP TYPE "public"."StrategyType_old";
COMMIT;

-- AlterTable
ALTER TABLE "TemplateStage" ADD COLUMN     "name" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "WorkflowInstance" ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "WorkflowTemplate" DROP COLUMN "priority",
ADD COLUMN     "created_by_id" TEXT NOT NULL,
ADD COLUMN     "description" TEXT NOT NULL,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "updated_by_id" TEXT NOT NULL;

-- AddForeignKey
ALTER TABLE "WorkflowTemplate" ADD CONSTRAINT "WorkflowTemplate_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowTemplate" ADD CONSTRAINT "WorkflowTemplate_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
