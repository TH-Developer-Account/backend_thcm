-- CreateTable
CREATE TABLE "Guest" (
    "id" TEXT NOT NULL,
    "mobile" TEXT,
    "email" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Guest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Guest_mobile_key" ON "Guest"("mobile");

-- CreateIndex
CREATE UNIQUE INDEX "Guest_email_key" ON "Guest"("email");

-- CreateIndex
CREATE INDEX "Guest_mobile_idx" ON "Guest"("mobile");

-- CreateIndex
CREATE INDEX "Guest_email_idx" ON "Guest"("email");
