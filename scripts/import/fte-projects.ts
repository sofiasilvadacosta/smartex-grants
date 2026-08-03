import { prisma } from "../../src/lib/db";
import { loadWorkbook, getSheet, asString, asNumber, isRowEmpty } from "./lib/workbook";

// Texia and TexQualis are budgeted as Atividade × Perfil, with a fixed eligible
// cost per FTE rather than real salaries. Both sheets share the same layout,
// but the header sits on a different row and TexQualis has a third FTE year, so
// each one declares its own column positions.
interface FteSheet {
  sheetName: string;
  projectCode: string;
  headerRow: number;
  firstDataRow: number;
  fteRate: number;
  activity: number;
  tipo: number;
  externalProfile: number;
  profile: number;
  // Per-year columns are the source of truth. The sheets' own "Total" columns
  // are unreliable — in TexQualis they sit at zero on 10 rows whose yearly
  // values are non-zero, and the sheet's own Total row for money sums the
  // yearly columns, not the Total column.
  fteYears: number[];
  investmentYears: number[];
  // Read only to cross-check against the yearly sums and report divergence.
  fteTotal: number;
  investmentTotal: number;
  // Column holding the amount submitted in the 1st payment request. Texia
  // records it per activity (sparse, on the activity's first row); TexQualis
  // has no execution recorded yet.
  firstPpColumn: number | null;
}

const SHEETS: FteSheet[] = [
  {
    sheetName: "Texia",
    projectCode: "TEXIA",
    headerRow: 5,
    firstDataRow: 6,
    fteRate: 5189,
    activity: 2,
    tipo: 3,
    externalProfile: 4,
    profile: 5,
    fteYears: [6, 7],
    investmentYears: [10, 11],
    fteTotal: 8,
    investmentTotal: 12,
    firstPpColumn: 13,
  },
  {
    sheetName: "TexQualis",
    projectCode: "TEXQUALIS",
    headerRow: 6,
    firstDataRow: 7,
    fteRate: 4432,
    activity: 2,
    tipo: 3,
    externalProfile: 4,
    profile: 5,
    fteYears: [6, 7, 8],
    investmentYears: [11, 12, 13],
    fteTotal: 9,
    investmentTotal: 14,
    firstPpColumn: null,
  },
];

// Rows below the data are the sheet's own roll-ups, not budget lines.
const SUMMARY_LABELS = new Set(["total", "financiamento", "grant (%)"]);

export interface FteImportSummary {
  budgetLinesCreated: number;
  budgetLinesUpdated: number;
  plannedFteTotal: number;
  eligibleCostTotal: number;
  firstPpSubmitted: number | null;
  skippedRows: string[];
  // Rows whose "Total" column disagrees with the sum of its yearly columns.
  // Split because the two cases mean different things: a money-only mismatch
  // is the Total column under-summing (systematic in TexQualis), while an FTE
  // mismatch means the whole row was zeroed out and may be cancelled work.
  moneyTotalMismatchCount: number;
  moneyTotalMismatchAmount: number;
  fteTotalMismatches: string[];
}

export async function importFteProjects(
  workbookPath: string,
  projectIdByCode: Record<string, string>,
): Promise<Record<string, FteImportSummary>> {
  const workbook = await loadWorkbook(workbookPath);
  const summary: Record<string, FteImportSummary> = {};

  for (const map of SHEETS) {
    const projectId = projectIdByCode[map.projectCode];
    if (!projectId) continue;

    await prisma.project.update({ where: { id: projectId }, data: { fteRate: map.fteRate } });

    const sheet = getSheet(workbook, map.sheetName);
    let created = 0;
    let updated = 0;
    let plannedFteTotal = 0;
    let eligibleCostTotal = 0;
    let firstPpSubmitted: number | null = null;
    const skippedRows: string[] = [];
    const fteTotalMismatches: string[] = [];
    let moneyTotalMismatchCount = 0;
    let moneyTotalMismatchAmount = 0;
    const seenKeys = new Set<string>();

    const sumColumns = (row: ReturnType<typeof sheet.getRow>, columns: number[]) =>
      columns.reduce((sum, col) => sum + (asNumber(row.getCell(col).value) ?? 0), 0);

    for (let r = map.firstDataRow; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      if (isRowEmpty(row)) continue;

      const profile = asString(row.getCell(map.profile).value);
      if (profile && SUMMARY_LABELS.has(profile.toLowerCase())) break;

      const activityRaw = asString(row.getCell(map.activity).value);
      const fteTotal = sumColumns(row, map.fteYears);
      const investmentTotal = sumColumns(row, map.investmentYears);

      const statedFte = asNumber(row.getCell(map.fteTotal).value) ?? 0;
      const statedInvestment = asNumber(row.getCell(map.investmentTotal).value) ?? 0;
      if (Math.abs(statedInvestment - investmentTotal) > 0.01) {
        moneyTotalMismatchCount++;
        moneyTotalMismatchAmount += investmentTotal - statedInvestment;
      }
      if (Math.abs(statedFte - fteTotal) > 0.01) {
        fteTotalMismatches.push(
          `linha ${r}: ${activityRaw ?? "?"} / ${profile ?? "?"} — anual ${fteTotal.toFixed(2)} FTE ` +
            `(${investmentTotal.toFixed(2)} €) mas coluna Total a ${statedFte.toFixed(2)} FTE`,
        );
      }

      // Accumulate the 1st-PP amount wherever it appears (Texia puts it on the
      // first row of each activity, so it must be read before the row filters).
      if (map.firstPpColumn) {
        const pp = asNumber(row.getCell(map.firstPpColumn).value);
        if (pp != null && pp > 0) firstPpSubmitted = (firstPpSubmitted ?? 0) + pp;
      }

      if (!activityRaw || !profile) {
        skippedRows.push(`linha ${r}: atividade ou perfil em branco`);
        continue;
      }
      // Rows with zero planned FTE and no money are placeholders in the plan.
      if (!fteTotal && !investmentTotal) {
        skippedRows.push(`linha ${r}: ${activityRaw} / ${profile} sem FTE nem investimento`);
        continue;
      }

      // Normalize "3 - " (TexQualis has a stray trailing dash) and Texia's
      // long "1 - Gestão e Planeamento do projeto" to a stable key.
      const activity = activityRaw.replace(/\s*-\s*$/, "").trim();
      const key = `${activity}|${profile}`;
      // The same activity/profile pair appears more than once in TexQualis
      // (apparently duplicated rows); sum them into a single budget line rather
      // than letting the last one silently win.
      const isRepeat = seenKeys.has(key);
      seenKeys.add(key);

      const existing = await prisma.budgetLine.findUnique({
        where: {
          projectId_activity_category_trlPhase: {
            projectId,
            activity,
            category: profile,
            trlPhase: "",
          },
        },
      });

      const plannedFte = (isRepeat ? Number(existing?.plannedFte ?? 0) : 0) + (fteTotal ?? 0);
      const eligibleCost = (isRepeat ? Number(existing?.eligibleCost ?? 0) : 0) + (investmentTotal ?? 0);

      if (existing) {
        await prisma.budgetLine.update({
          where: { id: existing.id },
          data: {
            plannedFte,
            eligibleCost,
            externalProfile: asString(row.getCell(map.externalProfile).value),
          },
        });
        if (!isRepeat) updated++;
      } else {
        const line = await prisma.budgetLine.create({
          data: {
            projectId,
            activity,
            category: profile,
            trlPhase: "",
            externalProfile: asString(row.getCell(map.externalProfile).value),
            plannedFte,
            eligibleCost,
            financingAmount: 0,
          },
        });
        await prisma.budgetChangeLog.create({
          data: {
            budgetLineId: line.id,
            changeType: "CREATE",
            newValue: JSON.stringify({ plannedFte, eligibleCost }),
            reason: `Importação inicial da folha ${map.sheetName}`,
          },
        });
        created++;
      }

      plannedFteTotal += fteTotal;
      eligibleCostTotal += investmentTotal;
    }

    // Register the 1st payment request with the amount the sheet says was
    // submitted. It is recorded per activity, not per profile, so the request
    // total is trustworthy while a per-budget-line split is not — the
    // execution rows themselves are entered in the app from here on.
    if (firstPpSubmitted != null) {
      await prisma.paymentRequest.upsert({
        where: { projectId_ppNumber: { projectId, ppNumber: "1" } },
        update: { requestedAmount: firstPpSubmitted },
        create: {
          projectId,
          ppNumber: "1",
          requestedAmount: firstPpSubmitted,
          notes:
            `Total submetido lido da coluna "1 PP Elegível" da folha ${map.sheetName} ` +
            `(registada por atividade, não por perfil).`,
        },
      });
    }

    summary[map.projectCode] = {
      budgetLinesCreated: created,
      budgetLinesUpdated: updated,
      plannedFteTotal: Math.round(plannedFteTotal * 100) / 100,
      eligibleCostTotal: Math.round(eligibleCostTotal * 100) / 100,
      firstPpSubmitted,
      skippedRows,
      moneyTotalMismatchCount,
      moneyTotalMismatchAmount: Math.round(moneyTotalMismatchAmount * 100) / 100,
      fteTotalMismatches,
    };
  }

  return summary;
}
