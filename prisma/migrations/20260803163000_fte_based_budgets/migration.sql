-- Fixed eligible cost per FTE for projects budgeted that way (Texia, TexQualis).
ALTER TABLE "Project" ADD COLUMN "fteRate" DECIMAL(12,2);

-- FTE-based projects approve budget per profile within an activity.
ALTER TABLE "BudgetLine" ADD COLUMN "activity" TEXT NOT NULL DEFAULT '';
ALTER TABLE "BudgetLine" ADD COLUMN "externalProfile" TEXT;
ALTER TABLE "BudgetLine" ADD COLUMN "plannedFte" DECIMAL(8,2);

DROP INDEX "BudgetLine_projectId_category_trlPhase_key";
CREATE UNIQUE INDEX "BudgetLine_projectId_activity_category_trlPhase_key"
  ON "BudgetLine"("projectId", "activity", "category", "trlPhase");

-- Execution entered as FTE instead of a real salary computation.
ALTER TABLE "PersonnelAllocation" ADD COLUMN "fte" DECIMAL(8,2);
