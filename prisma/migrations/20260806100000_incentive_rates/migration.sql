-- The share of eligible cost the funder pays. Without it the platform can say
-- what may be spent but not what will be received, which is the last number a
-- payment request needs.
-- AlterTable
ALTER TABLE "Project" ADD COLUMN "incentiveRate" DECIMAL(6,4);

-- AlterTable
ALTER TABLE "BudgetLine" ADD COLUMN "incentiveRate" DECIMAL(6,4);

-- Rates given by Sofia. Editable on each project's page: these are the starting
-- point, not a fact the platform should defend.
UPDATE "Project" SET "incentiveRate" = 0.70 WHERE "code" = 'TEXQUALIS';
UPDATE "Project" SET "incentiveRate" = 0.64 WHERE "code" = 'TEXIA';
UPDATE "Project" SET "incentiveRate" = 0.75 WHERE "code" = 'DEFECT_FREE';
UPDATE "Project" SET "incentiveRate" = 0.40 WHERE "code" = 'INTERNACIONALIZACAO';

-- Produtech and TexP@ct pay by TRL phase: 75% on the lower phases, 50% on the
-- higher ones. Recorded per line rather than per project, and left for a human
-- to confirm — on Produtech this rule reaches 881 823,26 € against the
-- 956 110,99 € the approved sheet states, a gap of 74 287,73 € that no rate on
-- the untagged lines can close. (75% on everything but "Feiras" at 50% lands
-- within 10 € of the stated total, which is a fit, not evidence.)
UPDATE "BudgetLine" SET "incentiveRate" = 0.75
  WHERE "trlPhase" = '3-4'
    AND "projectId" IN (SELECT "id" FROM "Project" WHERE "code" IN ('PRODUTECH', 'TEXPACT'));
UPDATE "BudgetLine" SET "incentiveRate" = 0.50
  WHERE "trlPhase" = '5-9'
    AND "projectId" IN (SELECT "id" FROM "Project" WHERE "code" IN ('PRODUTECH', 'TEXPACT'));
