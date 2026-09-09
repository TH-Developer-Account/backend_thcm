-- CreateTable
CREATE TABLE "event_proposals" (
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

    CONSTRAINT "event_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" SERIAL NOT NULL,
    "department_code" TEXT NOT NULL,
    "department_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regions" (
    "id" SERIAL NOT NULL,
    "region_code" TEXT NOT NULL,
    "region_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "regions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branches" (
    "id" SERIAL NOT NULL,
    "branch_code" TEXT NOT NULL,
    "branch_name" TEXT NOT NULL,
    "region_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_scales" (
    "id" SERIAL NOT NULL,
    "scale_code" TEXT NOT NULL,
    "scale_name" TEXT NOT NULL,
    "max_budget" DECIMAL(65,30) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_scales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_master" (
    "id" SERIAL NOT NULL,
    "financial_year" TEXT NOT NULL,
    "total_budget" DECIMAL(65,30) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budget_master_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_names" (
    "id" SERIAL NOT NULL,
    "event_code" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "event_names_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "event_proposals_proposal_number_key" ON "event_proposals"("proposal_number");

-- CreateIndex
CREATE UNIQUE INDEX "departments_department_code_key" ON "departments"("department_code");

-- CreateIndex
CREATE UNIQUE INDEX "regions_region_code_key" ON "regions"("region_code");

-- CreateIndex
CREATE UNIQUE INDEX "branches_branch_code_key" ON "branches"("branch_code");

-- CreateIndex
CREATE UNIQUE INDEX "event_scales_scale_code_key" ON "event_scales"("scale_code");

-- CreateIndex
CREATE UNIQUE INDEX "event_names_event_code_key" ON "event_names"("event_code");

-- AddForeignKey
ALTER TABLE "event_proposals" ADD CONSTRAINT "event_proposals_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_proposals" ADD CONSTRAINT "event_proposals_region_id_fkey" FOREIGN KEY ("region_id") REFERENCES "regions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_proposals" ADD CONSTRAINT "event_proposals_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_proposals" ADD CONSTRAINT "event_proposals_event_scale_id_fkey" FOREIGN KEY ("event_scale_id") REFERENCES "event_scales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_proposals" ADD CONSTRAINT "event_proposals_budget_master_id_fkey" FOREIGN KEY ("budget_master_id") REFERENCES "budget_master"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_proposals" ADD CONSTRAINT "event_proposals_event_name_id_fkey" FOREIGN KEY ("event_name_id") REFERENCES "event_names"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
