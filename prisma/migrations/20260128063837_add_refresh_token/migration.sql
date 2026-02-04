/*
  Warnings:

  - You are about to drop the `user_otps` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `users` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE "user_otps";

-- DropTable
DROP TABLE "users";

-- CreateTable
CREATE TABLE "Users" (
    "id" TEXT NOT NULL,
    "first_name" VARCHAR(50) NOT NULL,
    "last_name" VARCHAR(50) NOT NULL,
    "email" VARCHAR(100) NOT NULL,
    "phone_number" VARCHAR(15) NOT NULL,
    "password" VARCHAR(255) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserOtps" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "otp_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "is_used" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserOtps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "token_id" VARCHAR(36) NOT NULL,
    "token_hash" VARCHAR(255) NOT NULL,
    "token" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip_address" TEXT,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Users_email_key" ON "Users"("email");

-- CreateIndex
CREATE INDEX "UserOtps_phone_idx" ON "UserOtps"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_token_id_key" ON "RefreshToken"("token_id");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_token_key" ON "RefreshToken"("token");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
