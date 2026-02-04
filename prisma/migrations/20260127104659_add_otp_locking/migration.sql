-- CreateTable
CREATE TABLE "user_otps" (
    "id" SERIAL NOT NULL,
    "phone" TEXT NOT NULL,
    "otp_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "is_used" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_otps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_otps_phone_idx" ON "user_otps"("phone");
