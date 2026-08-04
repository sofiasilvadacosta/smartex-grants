-- The funder's timesheet requires hours split by activity within each project,
-- so a person-month can now hold one row per activity. Existing rows came from
-- the planning sheet, which has no activity column, and keep "".
-- AlterTable
ALTER TABLE "ProjectHoursAllocation" ADD COLUMN "activity" TEXT NOT NULL DEFAULT '';

-- DropIndex
DROP INDEX "ProjectHoursAllocation_personId_projectId_yearMonth_key";

-- CreateIndex
CREATE UNIQUE INDEX "ProjectHoursAllocation_personId_projectId_yearMonth_activity_key" ON "ProjectHoursAllocation"("personId", "projectId", "yearMonth", "activity");
