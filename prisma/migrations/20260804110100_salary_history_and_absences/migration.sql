-- CreateEnum
CREATE TYPE "AbsenceType" AS ENUM ('VACATION', 'SICK', 'PARENTAL', 'UNPAID', 'OTHER');

-- CreateTable
CREATE TABLE "SalaryRecord" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "effectiveFrom" TEXT NOT NULL,
    "grossAnnual" DECIMAL(12,2),
    "monthlyBase" DECIMAL(12,2),
    "socialSecurityRate" DECIMAL(6,4),
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "SalaryRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Absence" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "yearMonth" TEXT NOT NULL,
    "type" "AbsenceType" NOT NULL,
    "days" DECIMAL(5,2) NOT NULL,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "Absence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SalaryRecord_personId_effectiveFrom_idx" ON "SalaryRecord"("personId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "SalaryRecord_personId_effectiveFrom_key" ON "SalaryRecord"("personId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "Absence_personId_yearMonth_idx" ON "Absence"("personId", "yearMonth");

-- AddForeignKey
ALTER TABLE "SalaryRecord" ADD CONSTRAINT "SalaryRecord_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalaryRecord" ADD CONSTRAINT "SalaryRecord_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Absence" ADD CONSTRAINT "Absence_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Absence" ADD CONSTRAINT "Absence_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "PersonMonthCapacity" ADD COLUMN     "nonProjectHours" DECIMAL(8,2);

-- Reconstruct the real monthly-base history from the RH sheets already imported.
-- Those sheets carry "RBM Elegível" per person per month, so every month where
-- it changed is a genuine, dated pay change — a far better history than the
-- single current figure HR tracks. One row per change (gaps and islands), not
-- one per month.
WITH per_month AS (
    -- MAX, not DISTINCT: the same person-month can appear on two projects' sheets
    -- and, where they disagree, one value has to win rather than produce two
    -- conflicting records for one month.
    SELECT "personId", "yearMonth", MAX("eligibleBaseSalary") AS rbm, MAX("socialSecurityRate") AS ss
    FROM "PersonnelAllocation"
    WHERE "personId" IS NOT NULL AND "eligibleBaseSalary" > 0
    GROUP BY "personId", "yearMonth"
), changes AS (
    SELECT *, LAG(rbm) OVER (PARTITION BY "personId" ORDER BY "yearMonth") AS previous_rbm
    FROM per_month
)
INSERT INTO "SalaryRecord" ("id", "personId", "effectiveFrom", "monthlyBase", "socialSecurityRate", "reason", "createdAt")
SELECT
    gen_random_uuid()::text,
    "personId",
    "yearMonth",
    rbm,
    ss,
    'Reconstruído das folhas de RH (RBM Elegível declarada nesse mês).',
    CURRENT_TIMESTAMP
FROM changes
WHERE previous_rbm IS NULL OR previous_rbm <> rbm;

-- The annual figure HR tracks is a single current snapshot with no history, so
-- it attaches to each person's most recent record — the month it describes —
-- rather than being spread backwards over pay it never applied to.
UPDATE "SalaryRecord" s
SET "grossAnnual" = p."grossSalary",
    "reason" = s."reason" || ' Salário anual da folha DADOS (valor atual, sem histórico).'
FROM "Person" p
WHERE s."personId" = p."id"
  AND p."grossSalary" IS NOT NULL
  AND s."effectiveFrom" = (
      SELECT MAX(s2."effectiveFrom") FROM "SalaryRecord" s2 WHERE s2."personId" = p."id"
  );

-- Staff who never appear on an RH sheet have no monthly base to reconstruct, so
-- they get a record carrying only the annual figure. The allocation screen shows
-- these as "RBM em falta" rather than inventing a monthly base for them.
INSERT INTO "SalaryRecord" ("id", "personId", "effectiveFrom", "grossAnnual", "reason", "createdAt")
SELECT
    gen_random_uuid()::text,
    p."id",
    COALESCE(to_char(p."entryDate", 'YYYY-MM'), '2023-01'),
    p."grossSalary",
    'Salário anual da folha DADOS. Sem RBM Elegível: esta pessoa não consta de nenhuma folha de RH, por isso falta a base mensal para calcular custo elegível.',
    CURRENT_TIMESTAMP
FROM "Person" p
WHERE p."grossSalary" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "SalaryRecord" s WHERE s."personId" = p."id");

-- AlterTable
ALTER TABLE "Person" DROP COLUMN "grossSalary";

-- RHAQ is approved and running but deliberately not managed here. Marking it
-- rather than deleting it keeps the decision visible and one click away from
-- being reversed.
UPDATE "Project" SET "status" = 'EXCLUDED' WHERE "code" = 'RHAQ';
