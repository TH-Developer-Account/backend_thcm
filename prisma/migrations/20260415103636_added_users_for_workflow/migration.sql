-- CreateTable
CREATE TABLE "WorkFlowTemplateUser" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkFlowTemplateUser_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkFlowTemplateUser_templateId_userId_idx" ON "WorkFlowTemplateUser"("templateId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkFlowTemplateUser_templateId_userId_key" ON "WorkFlowTemplateUser"("templateId", "userId");

-- AddForeignKey
ALTER TABLE "WorkFlowTemplateUser" ADD CONSTRAINT "WorkFlowTemplateUser_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "WorkflowTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkFlowTemplateUser" ADD CONSTRAINT "WorkFlowTemplateUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
