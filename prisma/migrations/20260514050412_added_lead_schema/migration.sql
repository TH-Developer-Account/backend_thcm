-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "epcId" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "email" VARCHAR(100),
    "phone" VARCHAR(15),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Lead_epcId_idx" ON "Lead"("epcId");

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_epcId_fkey" FOREIGN KEY ("epcId") REFERENCES "EventProposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
