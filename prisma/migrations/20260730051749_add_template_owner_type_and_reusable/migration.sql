-- CreateEnum
CREATE TYPE "TemplateOwnerType" AS ENUM ('ADMIN', 'USER');

-- AlterTable
ALTER TABLE "WorkflowTemplate" ADD COLUMN     "isReusable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "ownerType" "TemplateOwnerType" NOT NULL DEFAULT 'ADMIN';

-- CreateIndex
CREATE INDEX "WorkflowTemplate_ownerType_idx" ON "WorkflowTemplate"("ownerType");

-- CreateIndex
CREATE INDEX "WorkflowTemplate_isReusable_idx" ON "WorkflowTemplate"("isReusable");
