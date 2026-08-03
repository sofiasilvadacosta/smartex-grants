import { prisma } from "../../src/lib/db";
import {
  loadWorkbook,
  getSheet,
  findHeaderRow,
  buildHeaderIndex,
  normalizeHeader,
  cellAt,
  rowValues,
  cellText,
  asString,
  asNumber,
  asDate,
  asBoolFromSN,
  sourceRowId,
} from "./lib/workbook";
import { upsertInvoiceRow, type ImportCounters, type RawInvoiceRow } from "./lib/upsert-invoice";
import { pruneStaleInvoices } from "./lib/prune";

// "Produtech" and "TexP@ct" share one consistent sheet family: a clean
// "<Project>_Approved" budget-by-rubrica sheet, and a "<Project>_Investments"
// invoice sheet linked back to a rubrica via the "Nº ordem (mapa investim)"
// compound key. Column *names* repeat (duplicate "Tipo"/"Nº PP" columns) but
// are redundant repeats here, so header-name lookup (first occurrence) is safe
// — unlike the newer "PP_*" sheets in family-b.ts where duplicate names are
// distinct value groups that must be read positionally.
const TRL_PATTERN = /\(TRL\s*([0-9]+-[0-9]+)\)/i;

interface ProjectSheets {
  code: string;
  approvedSheet: string;
  investmentsSheet: string;
}

const PROJECTS: ProjectSheets[] = [
  { code: "PRODUTECH", approvedSheet: "Produtech_Approved", investmentsSheet: "Produtech_Investments" },
  { code: "TEXPACT", approvedSheet: "TEXP@CT_Approved", investmentsSheet: "Texp@ct_Investments" },
];

async function upsertBudgetLine(
  projectId: string,
  category: string,
  trlPhase: string,
  eligibleCost: number,
  financingAmount: number,
  declaredExecuted: number | null,
): Promise<{ wasCreated: boolean }> {
  const existing = await prisma.budgetLine.findUnique({
    // Invoice-based projects have no per-activity budget split, so activity is "".
    where: {
      projectId_activity_category_trlPhase_orderNumber: {
        projectId,
        activity: "",
        category,
        trlPhase,
        orderNumber: "",
      },
    },
  });

  if (!existing) {
    const created = await prisma.budgetLine.create({
      data: { projectId, category, trlPhase, eligibleCost, financingAmount, declaredExecuted },
    });
    await prisma.budgetChangeLog.create({
      data: {
        budgetLineId: created.id,
        changeType: "CREATE",
        newValue: JSON.stringify({ eligibleCost, financingAmount }),
        reason: "Initial import from _Approved sheet",
      },
    });
    return { wasCreated: true };
  }

  const prevEligible = Number(existing.eligibleCost);
  const prevFinancing = Number(existing.financingAmount);
  if (prevEligible !== eligibleCost || prevFinancing !== financingAmount) {
    await prisma.budgetChangeLog.create({
      data: {
        budgetLineId: existing.id,
        changeType: "UPDATE",
        changedField: "eligibleCost/financingAmount",
        oldValue: JSON.stringify({ eligibleCost: prevEligible, financingAmount: prevFinancing }),
        newValue: JSON.stringify({ eligibleCost, financingAmount }),
        reason: "Re-import from _Approved sheet detected a change",
      },
    });
    await prisma.budgetLine.update({
      where: { id: existing.id },
      data: { eligibleCost, financingAmount, declaredExecuted },
    });
    return { wasCreated: false };
  }
  await prisma.budgetLine.update({ where: { id: existing.id }, data: { declaredExecuted } });
  return { wasCreated: false };
}

async function importApprovedSheet(workbook: Awaited<ReturnType<typeof loadWorkbook>>, sheetName: string, projectId: string) {
  const sheet = getSheet(workbook, sheetName);
  const headerRow = findHeaderRow(sheet);
  // The sheet's own per-rubrica "Executado" tally. Kept as declaredExecuted so
  // the project page can compare it against the execution actually linked here
  // — for these two projects the "Nº ordem" is inconsistent, so that comparison
  // is the only way to see where the automatic matching went wrong.
  // Produtech repeats the header and only the rightmost column carries values,
  // so take the last occurrence.
  const headerCells = rowValues(sheet.getRow(headerRow));
  let executedCol: number | null = null;
  headerCells.forEach((value, col) => {
    if (normalizeHeader(cellText(value)) === "executado") executedCol = col;
  });

  let created = 0;
  let updated = 0;
  let declaredTotal = 0;
  let sheetTotal: number | null = null;

  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const shortCode = asString(row.getCell(1).value);
    const description = asString(row.getCell(2).value);
    const label = (description ?? "").trim().toUpperCase();
    if (label === "TOTAL") {
      // The sheet's own total for the Executado column, used below to prove the
      // per-line figures were read from the right column.
      if (executedCol !== null) sheetTotal = asNumber(row.getCell(executedCol).value);
      break;
    }
    if (label === "FINANCIAMENTO") break; // everything after is summary/unrelated cruft

    const category = shortCode ?? description;
    if (!category) continue;

    const eligibleCost = asNumber(row.getCell(3).value) ?? 0;
    const financingAmount = asNumber(row.getCell(4).value) ?? 0;
    const trlMatch = description ? TRL_PATTERN.exec(description) : null;
    const trlPhase = trlMatch ? trlMatch[1] : "";

    const declaredExecuted =
      executedCol !== null ? asNumber(row.getCell(executedCol).value) : null;
    if (declaredExecuted !== null) declaredTotal += declaredExecuted;

    const { wasCreated } = await upsertBudgetLine(
      projectId,
      category,
      trlPhase,
      eligibleCost,
      financingAmount,
      declaredExecuted,
    );
    if (wasCreated) created++;
    else updated++;
  }

  return {
    created,
    updated,
    declaredTotal: Math.round(declaredTotal * 100) / 100,
    sheetTotal: sheetTotal === null ? null : Math.round(sheetTotal * 100) / 100,
  };
}

async function importInvestmentsSheet(
  workbook: Awaited<ReturnType<typeof loadWorkbook>>,
  sheetName: string,
  projectId: string,
  counters: ImportCounters,
) {
  const sheet = getSheet(workbook, sheetName);
  const headerRow = findHeaderRow(sheet);
  const idx = buildHeaderIndex(sheet, headerRow);

  const col = (name: string) => idx.get(normalizeHeader(name));
  const seenRowIds: string[] = [];

  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const supplierName = asString(cellAt(row, col("Fornecedor")));
    const eligibleAmount = asNumber(cellAt(row, col("Elegível")));
    if (!supplierName && eligibleAmount == null) continue; // blank/footer row

    const docNumber = asString(cellAt(row, col("Nº")));
    const docDate = asDate(cellAt(row, col("Data")));
    const category = asString(cellAt(row, col("Tipo"))) ?? "Sem categoria";
    const rawSourceRef = asString(cellAt(row, col("Nº ordem (mapa investim)")));

    const raw: RawInvoiceRow = {
      sourceSheet: sheetName,
      sourceRowId: sourceRowId(sheetName, r, docNumber, supplierName, docDate?.toISOString()),
      projectId,
      category,
      rawSourceRef,
      supplierName,
      supplierTaxId: asString(cellAt(row, col("NIF"))),
      country: asString(cellAt(row, col("País"))),
      docNumber,
      docDate,
      totalValue: asNumber(cellAt(row, col("Valor total"))),
      vatValue: asNumber(cellAt(row, col("IVA total"))),
      nonDeductibleVat: asNumber(cellAt(row, col("IVA não dedutivel"))),
      eligibleAmount: eligibleAmount ?? 0,
      presentedTotal: null,
      presentedVat: null,
      presentedEligible: null,
      paidTotal: null,
      paidEligible: null,
      paymentMethod: asString(cellAt(row, col("Forma"))),
      paymentReference: asString(cellAt(row, col("Refª"))),
      paymentDate: asDate(cellAt(row, col("Data2"))) ?? asDate(cellAt(row, col("Data3"))),
      paymentDocValue: asNumber(cellAt(row, col("Valor doc."))),
      ppNumber: asString(cellAt(row, col("Nº PP"))),
      eligibilityCertified: asBoolFromSN(cellAt(row, col("S/N"))),
      obs: asString(cellAt(row, col("Obs"))),
    };

    seenRowIds.push(raw.sourceRowId);
    await upsertInvoiceRow(raw, counters);
  }

  return pruneStaleInvoices(projectId, sheetName, seenRowIds);
}

export async function importFamilyA(workbookPath: string, projectIds: Record<string, string>) {
  const workbook = await loadWorkbook(workbookPath);
  const summary: Record<string, unknown> = {};

  for (const project of PROJECTS) {
    const projectId = projectIds[project.code];
    if (!projectId) continue;

    const budgetSummary = await importApprovedSheet(workbook, project.approvedSheet, projectId);

    const counters: ImportCounters = { processed: 0, matched: 0, unmatched: 0, ambiguous: 0 };
    const pruned = await importInvestmentsSheet(
      workbook,
      project.investmentsSheet,
      projectId,
      counters,
    );

    summary[project.code] = { budgetLines: budgetSummary, invoices: counters, pruned };
  }

  return summary;
}
