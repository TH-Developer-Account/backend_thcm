-- CreateTable
CREATE TABLE "BankBranch" (
    "id" TEXT NOT NULL,
    "ifsc" VARCHAR(11) NOT NULL,
    "bankName" TEXT NOT NULL,
    "branchName" TEXT NOT NULL,
    "address" TEXT,
    "city" TEXT,
    "district" TEXT,
    "state" TEXT,
    "searchVector" tsvector,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankBranch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BankBranch_ifsc_key" ON "BankBranch"("ifsc");

-- CreateIndex
CREATE INDEX "BankBranch_bankName_idx" ON "BankBranch"("bankName");

-- CreateIndex
CREATE INDEX "BankBranch_searchVector_idx" ON "BankBranch" USING GIN ("searchVector");
