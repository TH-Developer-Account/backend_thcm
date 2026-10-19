/*
  Warnings:

  - You are about to drop the `branches` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `budget_master` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `daily_visitors` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `departments` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `event_names` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `event_proposals` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `event_scales` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `password_reset_token` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `refresh_token` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `regions` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `users` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "event_proposals" DROP CONSTRAINT "event_proposals_branch_id_fkey";

-- DropForeignKey
ALTER TABLE "event_proposals" DROP CONSTRAINT "event_proposals_budget_master_id_fkey";

-- DropForeignKey
ALTER TABLE "event_proposals" DROP CONSTRAINT "event_proposals_department_id_fkey";

-- DropForeignKey
ALTER TABLE "event_proposals" DROP CONSTRAINT "event_proposals_event_name_id_fkey";

-- DropForeignKey
ALTER TABLE "event_proposals" DROP CONSTRAINT "event_proposals_event_scale_id_fkey";

-- DropForeignKey
ALTER TABLE "event_proposals" DROP CONSTRAINT "event_proposals_region_id_fkey";

-- DropForeignKey
ALTER TABLE "password_reset_token" DROP CONSTRAINT "password_reset_token_user_id_fkey";

-- DropForeignKey
ALTER TABLE "refresh_token" DROP CONSTRAINT "refresh_token_user_id_fkey";

-- DropTable
DROP TABLE "branches";

-- DropTable
DROP TABLE "budget_master";

-- DropTable
DROP TABLE "daily_visitors";

-- DropTable
DROP TABLE "departments";

-- DropTable
DROP TABLE "event_names";

-- DropTable
DROP TABLE "event_proposals";

-- DropTable
DROP TABLE "event_scales";

-- DropTable
DROP TABLE "password_reset_token";

-- DropTable
DROP TABLE "refresh_token";

-- DropTable
DROP TABLE "regions";

-- DropTable
DROP TABLE "users";

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "first_name" VARCHAR(50) NOT NULL,
    "last_name" VARCHAR(50) NOT NULL,
    "email" VARCHAR(100) NOT NULL,
    "phone_number" VARCHAR(15) NOT NULL,
    "password" VARCHAR(255) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_default_login" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token" VARCHAR(255) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "token_id" VARCHAR(36) NOT NULL,
    "token_hash" VARCHAR(255) NOT NULL,
    "token" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip_address" TEXT,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyVisitors" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "total_visits" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyVisitors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventProposal" (
    "id" SERIAL NOT NULL,
    "proposal_number" TEXT NOT NULL,
    "event_from_date" TIMESTAMP(3) NOT NULL,
    "event_to_date" TIMESTAMP(3) NOT NULL,
    "event_description" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "event_objective" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "created_by" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL,
    "department_id" INTEGER NOT NULL,
    "region_id" INTEGER NOT NULL,
    "branch_id" INTEGER NOT NULL,
    "event_scale_id" INTEGER NOT NULL,
    "budget_master_id" INTEGER NOT NULL,
    "event_name_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Department" (
    "id" SERIAL NOT NULL,
    "department_code" TEXT NOT NULL,
    "department_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Region" (
    "id" SERIAL NOT NULL,
    "region_code" TEXT NOT NULL,
    "region_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Region_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Branch" (
    "id" SERIAL NOT NULL,
    "branch_code" TEXT NOT NULL,
    "branch_name" TEXT NOT NULL,
    "region_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventScale" (
    "id" SERIAL NOT NULL,
    "scale_code" TEXT NOT NULL,
    "scale_name" TEXT NOT NULL,
    "max_budget" DECIMAL(65,30) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventScale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetMaster" (
    "id" SERIAL NOT NULL,
    "financial_year" TEXT NOT NULL,
    "total_budget" DECIMAL(65,30) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BudgetMaster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventName" (
    "id" SERIAL NOT NULL,
    "event_code" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "EventName_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_number_key" ON "User"("phone_number");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_token_key" ON "PasswordResetToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_token_id_key" ON "RefreshToken"("token_id");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_token_key" ON "RefreshToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "DailyVisitors_date_key" ON "DailyVisitors"("date");

-- CreateIndex
CREATE INDEX "DailyVisitors_date_idx" ON "DailyVisitors"("date");

-- CreateIndex
CREATE UNIQUE INDEX "EventProposal_proposal_number_key" ON "EventProposal"("proposal_number");

-- CreateIndex
CREATE UNIQUE INDEX "Department_department_code_key" ON "Department"("department_code");

-- CreateIndex
CREATE UNIQUE INDEX "Region_region_code_key" ON "Region"("region_code");

-- CreateIndex
CREATE UNIQUE INDEX "Branch_branch_code_key" ON "Branch"("branch_code");

-- CreateIndex
CREATE UNIQUE INDEX "EventScale_scale_code_key" ON "EventScale"("scale_code");

-- CreateIndex
CREATE UNIQUE INDEX "EventName_event_code_key" ON "EventName"("event_code");

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventProposal" ADD CONSTRAINT "EventProposal_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventProposal" ADD CONSTRAINT "EventProposal_region_id_fkey" FOREIGN KEY ("region_id") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventProposal" ADD CONSTRAINT "EventProposal_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventProposal" ADD CONSTRAINT "EventProposal_event_scale_id_fkey" FOREIGN KEY ("event_scale_id") REFERENCES "EventScale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventProposal" ADD CONSTRAINT "EventProposal_budget_master_id_fkey" FOREIGN KEY ("budget_master_id") REFERENCES "BudgetMaster"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventProposal" ADD CONSTRAINT "EventProposal_event_name_id_fkey" FOREIGN KEY ("event_name_id") REFERENCES "EventName"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
