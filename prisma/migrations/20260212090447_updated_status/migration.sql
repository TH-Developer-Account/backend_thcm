-- DropIndex
DROP INDEX "event_proposal_search_idx";

-- AlterTable
ALTER TABLE "EventProposal" ALTER COLUMN "status" SET DEFAULT 'PENDING';
