-- DropForeignKey
ALTER TABLE "TemplateApprover" DROP CONSTRAINT "TemplateApprover_stageId_fkey";

-- DropForeignKey
ALTER TABLE "TemplateStage" DROP CONSTRAINT "TemplateStage_templateId_fkey";

-- AddForeignKey
ALTER TABLE "TemplateStage" ADD CONSTRAINT "TemplateStage_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "WorkflowTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemplateApprover" ADD CONSTRAINT "TemplateApprover_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "TemplateStage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
