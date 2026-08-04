import { prisma } from "../../src/lib/db";
import { asNumber, asString, getSheet, loadWorkbook } from "./lib/workbook";

/**
 * Builds the effective-dated pay history.
 *
 * Two sources, neither complete on its own:
 *
 *  - The RH sheets carry "RBM Elegível" per person per month, so every month
 *    where it changed is a real, dated pay change. This is the figure eligible
 *    cost is computed from, and the only one with any history.
 *  - The DADOS sheet carries an annual gross per person, with no history at all —
 *    a single current snapshot.
 *
 * So the monthly base becomes a row per change, and the annual figure attaches to
 * each person's most recent row, which is the month it actually describes. It is
 * deliberately not spread backwards over pay it never applied to, and neither
 * figure is derived from the other (see the note on SalaryRecord.monthlyBase).
 *
 * Must run after the RH imports.
 */

const GENERATED_REASON_RBM = "Reconstruído das folhas de RH (RBM Elegível declarada nesse mês).";
const GENERATED_REASON_ANNUAL = "Salário anual da folha DADOS (valor atual, sem histórico).";
const GENERATED_REASON_ANNUAL_ONLY =
  "Salário anual da folha DADOS. Sem RBM Elegível: esta pessoa não consta de nenhuma folha de RH, " +
  "por isso falta a base mensal para calcular custo elegível.";

export interface SalaryHistorySummary {
  monthlyBaseRecords: number;
  annualOnlyRecords: number;
  annualAttached: number;
  /** Records left untouched because somebody edited them in the app. */
  keptManual: number;
  peopleWithoutMonthlyBase: string[];
}

export async function importSalaryHistory(
  gestaoWorkbookPath: string,
): Promise<SalaryHistorySummary> {
  const workbook = await loadWorkbook(gestaoWorkbookPath);
  const sheet = getSheet(workbook, "DADOS");

  const annualByInitials = new Map<string, number>();
  for (let r = 4; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const initials = asString(row.getCell(11).value);
    const annual = asNumber(row.getCell(12).value);
    if (!initials || annual === null) continue;
    // First row wins, matching how people.ts resolves duplicate initials.
    if (!annualByInitials.has(initials)) annualByInitials.set(initials, annual);
  }

  const people = await prisma.person.findMany({ select: { id: true, initials: true } });
  const annualByPerson = new Map<string, number>();
  for (const person of people) {
    const annual = annualByInitials.get(person.initials);
    if (annual !== undefined) annualByPerson.set(person.id, annual);
  }

  // One row per person-month. MAX because the same month can appear on two
  // projects' sheets and, where they disagree, one value has to win rather than
  // produce two conflicting records for a single month.
  const declared = await prisma.personnelAllocation.groupBy({
    by: ["personId", "yearMonth"],
    where: { personId: { not: null }, eligibleBaseSalary: { gt: 0 } },
    _max: { eligibleBaseSalary: true, socialSecurityRate: true },
  });

  const byPerson = new Map<string, { yearMonth: string; rbm: number; ss: number | null }[]>();
  for (const row of declared) {
    const personId = row.personId!;
    const list = byPerson.get(personId) ?? [];
    list.push({
      yearMonth: row.yearMonth,
      rbm: Number(row._max.eligibleBaseSalary),
      ss: row._max.socialSecurityRate === null ? null : Number(row._max.socialSecurityRate),
    });
    byPerson.set(personId, list);
  }

  // A record somebody created or edited in the app is never overwritten by a
  // re-import — the same rule reconciliation follows for manual matches.
  const manual = await prisma.salaryRecord.findMany({
    where: { createdById: { not: null } },
    select: { personId: true, effectiveFrom: true },
  });
  const manualKeys = new Set(manual.map((m) => `${m.personId}|${m.effectiveFrom}`));

  const summary: SalaryHistorySummary = {
    monthlyBaseRecords: 0,
    annualOnlyRecords: 0,
    annualAttached: 0,
    keptManual: manualKeys.size,
    peopleWithoutMonthlyBase: [],
  };

  for (const [personId, months] of byPerson) {
    months.sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));
    let previousRbm: number | null = null;
    for (const month of months) {
      if (previousRbm !== null && previousRbm === month.rbm) continue;
      previousRbm = month.rbm;
      if (manualKeys.has(`${personId}|${month.yearMonth}`)) continue;

      await prisma.salaryRecord.upsert({
        where: { personId_effectiveFrom: { personId, effectiveFrom: month.yearMonth } },
        create: {
          personId,
          effectiveFrom: month.yearMonth,
          monthlyBase: month.rbm,
          socialSecurityRate: month.ss,
          reason: GENERATED_REASON_RBM,
        },
        update: {
          monthlyBase: month.rbm,
          socialSecurityRate: month.ss,
          reason: GENERATED_REASON_RBM,
        },
      });
      summary.monthlyBaseRecords++;
    }
  }

  for (const [personId, annual] of annualByPerson) {
    const latest = await prisma.salaryRecord.findFirst({
      where: { personId },
      orderBy: { effectiveFrom: "desc" },
      select: { id: true, effectiveFrom: true, reason: true, createdById: true },
    });

    if (!latest) {
      const person = await prisma.person.findUniqueOrThrow({
        where: { id: personId },
        select: { name: true, entryDate: true },
      });
      // No RH sheet mentions this person, so there is no monthly base to
      // reconstruct. '2023-01' is the first month any project runs, so a record
      // starting there covers every month the platform can ask about.
      const effectiveFrom = person.entryDate
        ? person.entryDate.toISOString().slice(0, 7)
        : "2023-01";
      await prisma.salaryRecord.upsert({
        where: { personId_effectiveFrom: { personId, effectiveFrom } },
        create: {
          personId,
          effectiveFrom,
          grossAnnual: annual,
          reason: GENERATED_REASON_ANNUAL_ONLY,
        },
        update: { grossAnnual: annual },
      });
      summary.annualOnlyRecords++;
      summary.peopleWithoutMonthlyBase.push(person.name);
      continue;
    }

    if (latest.createdById !== null) continue;
    await prisma.salaryRecord.update({
      where: { id: latest.id },
      data: {
        grossAnnual: annual,
        reason: latest.reason?.includes(GENERATED_REASON_ANNUAL)
          ? latest.reason
          : `${latest.reason ?? ""} ${GENERATED_REASON_ANNUAL}`.trim(),
      },
    });
    summary.annualAttached++;
  }

  summary.peopleWithoutMonthlyBase.sort();
  return summary;
}
