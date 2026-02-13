/*
  Warnings:

  - The primary key for the `Branch` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `BudgetMaster` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `Department` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `EventName` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `EventProposal` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `created_by` on the `EventProposal` table. All the data in the column will be lost.
  - You are about to drop the column `updated_by` on the `EventProposal` table. All the data in the column will be lost.
  - The primary key for the `EventScale` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `Region` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - Added the required column `created_by_id` to the `EventProposal` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updated_by_id` to the `EventProposal` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "EventProposal" DROP CONSTRAINT "EventProposal_branch_id_fkey";

-- DropForeignKey
ALTER TABLE "EventProposal" DROP CONSTRAINT "EventProposal_budget_master_id_fkey";

-- DropForeignKey
ALTER TABLE "EventProposal" DROP CONSTRAINT "EventProposal_department_id_fkey";

-- DropForeignKey
ALTER TABLE "EventProposal" DROP CONSTRAINT "EventProposal_event_name_id_fkey";

-- DropForeignKey
ALTER TABLE "EventProposal" DROP CONSTRAINT "EventProposal_event_scale_id_fkey";

-- DropForeignKey
ALTER TABLE "EventProposal" DROP CONSTRAINT "EventProposal_region_id_fkey";

-- AlterTable
ALTER TABLE "Branch" DROP CONSTRAINT "Branch_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "region_id" SET DATA TYPE TEXT,
ADD CONSTRAINT "Branch_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "Branch_id_seq";

-- AlterTable
ALTER TABLE "BudgetMaster" DROP CONSTRAINT "BudgetMaster_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ADD CONSTRAINT "BudgetMaster_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "BudgetMaster_id_seq";

-- AlterTable
ALTER TABLE "Department" DROP CONSTRAINT "Department_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ADD CONSTRAINT "Department_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "Department_id_seq";

-- AlterTable
ALTER TABLE "EventName" DROP CONSTRAINT "EventName_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ADD CONSTRAINT "EventName_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "EventName_id_seq";

-- AlterTable
ALTER TABLE "EventProposal" DROP CONSTRAINT "EventProposal_pkey",
DROP COLUMN "created_by",
DROP COLUMN "updated_by",
ADD COLUMN     "created_by_id" TEXT NOT NULL,
ADD COLUMN     "updated_by_id" TEXT NOT NULL,
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "department_id" SET DATA TYPE TEXT,
ALTER COLUMN "region_id" SET DATA TYPE TEXT,
ALTER COLUMN "branch_id" SET DATA TYPE TEXT,
ALTER COLUMN "event_scale_id" SET DATA TYPE TEXT,
ALTER COLUMN "budget_master_id" SET DATA TYPE TEXT,
ALTER COLUMN "event_name_id" SET DATA TYPE TEXT,
ADD CONSTRAINT "EventProposal_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "EventProposal_id_seq";

-- AlterTable
ALTER TABLE "EventScale" DROP CONSTRAINT "EventScale_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ADD CONSTRAINT "EventScale_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "EventScale_id_seq";

-- AlterTable
ALTER TABLE "Region" DROP CONSTRAINT "Region_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ADD CONSTRAINT "Region_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "Region_id_seq";

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

-- AddForeignKey
ALTER TABLE "EventProposal" ADD CONSTRAINT "EventProposal_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventProposal" ADD CONSTRAINT "EventProposal_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_region_id_fkey" FOREIGN KEY ("region_id") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


/* -----------------------------------------------------
   1️⃣ Add search_vector column (if not exists)
----------------------------------------------------- */
ALTER TABLE "EventProposal"
ADD COLUMN IF NOT EXISTS search_vector tsvector;


/* -----------------------------------------------------
   2️⃣ Populate existing rows (including department)
----------------------------------------------------- */
CREATE OR REPLACE FUNCTION build_eventproposal_search_vector(
    p_proposal_number text,
    p_event_description text,
    p_location text,
    p_department_id text,
    p_event_name_id text
)
RETURNS tsvector AS $$
DECLARE
    dept_name text;
    event_name text;
BEGIN
    SELECT department_name
    INTO dept_name
    FROM "Department"
    WHERE id = p_department_id;

    SELECT description
    INTO event_name
    FROM "EventName"
    WHERE id = p_event_name_id;

    RETURN
        setweight(to_tsvector('english', coalesce(p_proposal_number, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(p_event_description, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(p_location, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(dept_name, '')), 'C') ||
        setweight(to_tsvector('english', coalesce(event_name, '')), 'B');
END;
$$ LANGUAGE plpgsql STABLE;

UPDATE "EventProposal"
SET search_vector = build_eventproposal_search_vector(
    proposal_number,
    event_description,
    location,
    department_id,
    event_name_id
);

/* -----------------------------------------------------
   3️⃣ Create GIN index
----------------------------------------------------- */
CREATE INDEX IF NOT EXISTS event_proposal_search_idx
ON "EventProposal"
USING GIN (search_vector);


/* -----------------------------------------------------
   4️⃣ Trigger function for EventProposal
----------------------------------------------------- */
CREATE OR REPLACE FUNCTION event_proposal_search_vector_update()
RETURNS trigger AS $$
BEGIN
    NEW.search_vector :=
        build_eventproposal_search_vector(
            NEW.proposal_number,
            NEW.event_description,
            NEW.location,
            NEW.department_id,
            NEW.event_name_id
        );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

/* -----------------------------------------------------
   5️⃣ Attach trigger to EventProposal
----------------------------------------------------- */
DROP TRIGGER IF EXISTS event_proposal_search_trigger
ON "EventProposal";

CREATE TRIGGER event_proposal_search_trigger
BEFORE INSERT OR UPDATE
ON "EventProposal"
FOR EACH ROW
EXECUTE FUNCTION event_proposal_search_vector_update();

/* -----------------------------------------------------
   6️⃣ Trigger for Department name updates
----------------------------------------------------- */
CREATE OR REPLACE FUNCTION department_change_trigger()
RETURNS trigger AS $$
BEGIN
    UPDATE "EventProposal"
    SET department_id = department_id
    WHERE department_id = NEW.id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS department_name_update_trigger
ON "Department";

CREATE TRIGGER department_name_update_trigger
AFTER UPDATE OF department_name
ON "Department"
FOR EACH ROW
EXECUTE FUNCTION department_change_trigger();


/* -----------------------------------------------------
   6️⃣ Trigger for Event name updates
----------------------------------------------------- */

CREATE OR REPLACE FUNCTION eventname_change_trigger()
RETURNS trigger AS $$
BEGIN
    UPDATE "EventProposal"
    SET event_name_id = event_name_id
    WHERE event_name_id = NEW.id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS eventname_update_trigger
ON "EventName";

CREATE TRIGGER eventname_update_trigger
AFTER UPDATE OF description
ON "EventName"
FOR EACH ROW
EXECUTE FUNCTION eventname_change_trigger();

