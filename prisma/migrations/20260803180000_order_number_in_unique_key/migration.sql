-- A funder can approve several numbered lines sharing the same activity,
-- classification and year (e.g. Defect Free orders 16 and 41, and the six
-- travel lines). Without the order number in the key those rows overwrite each
-- other on import and their budget is silently lost.
UPDATE "BudgetLine" SET "orderNumber" = '' WHERE "orderNumber" IS NULL;
ALTER TABLE "BudgetLine" ALTER COLUMN "orderNumber" SET NOT NULL;
ALTER TABLE "BudgetLine" ALTER COLUMN "orderNumber" SET DEFAULT '';

DROP INDEX "BudgetLine_projectId_activity_category_trlPhase_key";
CREATE UNIQUE INDEX "BudgetLine_projectId_activity_category_trlPhase_orderNumber_key"
  ON "BudgetLine"("projectId", "activity", "category", "trlPhase", "orderNumber");
