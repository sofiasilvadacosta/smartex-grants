-- The approved staffing plan from the per-project sheets of the planning
-- workbook: who is expected to work on which activity, under which profile.
-- Used to narrow the candidates when a month of cost needs a budget line.
-- CreateTable
CREATE TABLE "PlannedAssignment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "personId" TEXT,
    "rawCollaborator" TEXT NOT NULL,
    "activity" TEXT NOT NULL,
    "profile" TEXT NOT NULL,
    "plannedFte" DECIMAL(8,2),
    "plannedHours" DECIMAL(10,2),
    "allocatedHours" DECIMAL(10,2),
    "sourceSheet" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlannedAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlannedAssignment_projectId_personId_idx" ON "PlannedAssignment"("projectId", "personId");

-- CreateIndex
CREATE UNIQUE INDEX "PlannedAssignment_projectId_rawCollaborator_activity_profil_key" ON "PlannedAssignment"("projectId", "rawCollaborator", "activity", "profile");

-- AddForeignKey
ALTER TABLE "PlannedAssignment" ADD CONSTRAINT "PlannedAssignment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannedAssignment" ADD CONSTRAINT "PlannedAssignment_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "ProjectHoursAllocation_personId_projectId_yearMonth_activity_ke" RENAME TO "ProjectHoursAllocation_personId_projectId_yearMonth_activit_key";

