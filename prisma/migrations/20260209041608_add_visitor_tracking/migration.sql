-- CreateTable
CREATE TABLE "daily_visitors" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "total_visits" INTEGER NOT NULL DEFAULT 0,
    "unique_ips" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_visitors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "daily_visitors_date_key" ON "daily_visitors"("date");

-- CreateIndex
CREATE INDEX "daily_visitors_date_idx" ON "daily_visitors"("date");
