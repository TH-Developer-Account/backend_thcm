/*
  Warnings:

  - You are about to drop the column `region_id` on the `Branch` table. All the data in the column will be lost.
  - You are about to drop the column `financial_year` on the `BudgetMaster` table. All the data in the column will be lost.
  - You are about to drop the column `total_budget` on the `BudgetMaster` table. All the data in the column will be lost.
  - You are about to drop the column `description` on the `EventName` table. All the data in the column will be lost.
  - You are about to drop the column `event_code` on the `EventName` table. All the data in the column will be lost.
  - You are about to drop the column `max_budget` on the `EventScale` table. All the data in the column will be lost.
  - You are about to drop the column `scale_code` on the `EventScale` table. All the data in the column will be lost.
  - You are about to drop the column `scale_name` on the `EventScale` table. All the data in the column will be lost.
  - The primary key for the `RolePermission` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - A unique constraint covering the columns `[code]` on the table `EventScale` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[workspaceId,moduleId,name]` on the table `Role` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `code` to the `BudgetMaster` table without a default value. This is not possible if the table is not empty.
  - Added the required column `fiscal_year` to the `BudgetMaster` table without a default value. This is not possible if the table is not empty.
  - Added the required column `id_desc` to the `BudgetMaster` table without a default value. This is not possible if the table is not empty.
  - Added the required column `value` to the `BudgetMaster` table without a default value. This is not possible if the table is not empty.
  - Added the required column `title` to the `EventName` table without a default value. This is not possible if the table is not empty.
  - Added the required column `code` to the `EventScale` table without a default value. This is not possible if the table is not empty.
  - Added the required column `title` to the `EventScale` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `permission` on the `RolePermission` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "PermissionAction" AS ENUM ('read', 'create', 'update', 'delete', 'approve', 'export');

-- DropForeignKey
ALTER TABLE "Branch" DROP CONSTRAINT "Branch_region_id_fkey";

-- DropForeignKey
ALTER TABLE "Role" DROP CONSTRAINT "Role_moduleId_fkey";

-- DropIndex
DROP INDEX "EventName_event_code_key";

-- DropIndex
DROP INDEX "EventScale_scale_code_key";

-- AlterTable
ALTER TABLE "Branch" DROP COLUMN "region_id";

-- AlterTable
ALTER TABLE "BudgetMaster" DROP COLUMN "financial_year",
DROP COLUMN "total_budget",
ADD COLUMN     "code" TEXT NOT NULL,
ADD COLUMN     "fiscal_year" TEXT NOT NULL,
ADD COLUMN     "id_desc" TEXT NOT NULL,
ADD COLUMN     "value" DECIMAL(65,30) NOT NULL;

-- AlterTable
ALTER TABLE "EventName" DROP COLUMN "description",
DROP COLUMN "event_code",
ADD COLUMN  "title" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "EventScale" DROP COLUMN "max_budget",
DROP COLUMN "scale_code",
DROP COLUMN "scale_name",
ADD COLUMN     "code" TEXT NOT NULL,
ADD COLUMN     "title" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Role" ALTER COLUMN "moduleId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "RolePermission" DROP CONSTRAINT "RolePermission_pkey",
DROP COLUMN "permission",
ADD COLUMN     "permission" "PermissionAction" NOT NULL,
ADD CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("roleId", "permission");

-- CreateIndex
CREATE UNIQUE INDEX "EventScale_code_key" ON "EventScale"("code");

-- CreateIndex
CREATE INDEX "Module_appId_idx" ON "Module"("appId");

-- CreateIndex
CREATE INDEX "Role_workspaceId_moduleId_idx" ON "Role"("workspaceId", "moduleId");

-- CreateIndex
CREATE UNIQUE INDEX "Role_workspaceId_moduleId_name_key" ON "Role"("workspaceId", "moduleId", "name");

-- CreateIndex
CREATE INDEX "UserAppRole_userId_workspaceId_idx" ON "UserAppRole"("userId", "workspaceId");

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "Module"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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

    SELECT title
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
AFTER UPDATE OF title
ON "EventName"
FOR EACH ROW
EXECUTE FUNCTION eventname_change_trigger();