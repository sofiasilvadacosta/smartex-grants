/*
  Warnings:

  - Made the column `trlPhase` on table `BudgetLine` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "BudgetLine" ALTER COLUMN "trlPhase" SET NOT NULL,
ALTER COLUMN "trlPhase" SET DEFAULT '';
