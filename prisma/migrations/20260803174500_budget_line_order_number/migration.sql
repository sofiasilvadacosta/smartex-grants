-- The funder's line number in the approved investment table ("Nº ordem").
-- Invoices already carry it, so this enables exact rubrica matching.
ALTER TABLE "BudgetLine" ADD COLUMN "orderNumber" TEXT;
CREATE INDEX "BudgetLine_projectId_orderNumber_idx" ON "BudgetLine"("projectId", "orderNumber");
