import { existsSync } from "node:fs";
import { prisma } from "../../src/lib/db";
import { loadWorkbook, getSheet, asString, asNumber, asDate, sourceRowId } from "./lib/workbook";
import { recomputeBudgetLineExecuted } from "../../src/lib/reconciliation";

// The portal's own "Lista geral de movimentos" export (FPP<projeto><pp>.xlsx).
// Preferred over the working spreadsheet for the same invoices because every
// row carries the funder's "Nº ordem", so each invoice links to its approved
// rubrica exactly, and because it includes rows the working sheet keeps in a
// separate table (travel).
//
// Column positions from the export's header row; names repeat across the
// apresentada / paga / pagamento value groups, so they must be read by index.
const COL = {
  id: 2,
  ppNumber: 3,
  country: 6,
  supplierTaxId: 7,
  supplierName: 8,
  docNumber: 10,
  docDate: 11,
  totalValue: 12,
  netValue: 13,
  vatValue: 14,
  orderNumber: 15,
  designation: 16,
  presentedTotal: 18,
  presentedNet: 19,
  presentedVat: 20,
  paidTotal: 21,
  paidNet: 22,
  paymentMethod: 25,
  paymentReference: 26,
  paymentDate: 27,
  paymentDocValue: 28,
} as const;

const FIRST_DATA_ROW = 6;

export interface MovimentosImportSummary {
  processed: number;
  created: number;
  updated: number;
  linkedByOrderNumber: number;
  withoutOrderNumber: number;
  presentedTotal: number;
  byPaymentRequest: Record<string, number>;
  replacedFromWorkingSheet: number;
}

export async function importMovimentos(
  workbookPath: string,
  projectId: string,
  replacesSourceSheet: string,
): Promise<MovimentosImportSummary | null> {
  if (!existsSync(workbookPath)) return null;

  const sheet = getSheet(await loadWorkbook(workbookPath), "Movimentos");
  const budgetLines = await prisma.budgetLine.findMany({
    where: { projectId, orderNumber: { not: "" } },
    select: { id: true, orderNumber: true },
  });
  const byOrderNumber = new Map(budgetLines.map((l) => [l.orderNumber, l.id]));

  const summary: MovimentosImportSummary = {
    processed: 0,
    created: 0,
    updated: 0,
    linkedByOrderNumber: 0,
    withoutOrderNumber: 0,
    presentedTotal: 0,
    byPaymentRequest: {},
    replacedFromWorkingSheet: 0,
  };
  const touched = new Set<string>();
  const seenRowIds: string[] = [];

  for (let r = FIRST_DATA_ROW; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const portalId = asString(row.getCell(COL.id).value);
    if (!portalId) continue;

    const orderNumber = asString(row.getCell(COL.orderNumber).value);
    const presentedNet = asNumber(row.getCell(COL.presentedNet).value) ?? 0;
    const ppNumber = asString(row.getCell(COL.ppNumber).value);
    const designation = asString(row.getCell(COL.designation).value);

    // The portal's row id is stable across re-exports of the same request.
    const rowId = sourceRowId("Movimentos", portalId);
    seenRowIds.push(rowId);

    const budgetLineId = orderNumber ? (byOrderNumber.get(orderNumber) ?? null) : null;
    if (budgetLineId) summary.linkedByOrderNumber++;
    if (!orderNumber) summary.withoutOrderNumber++;

    const existing = await prisma.invoice.findUnique({
      where: { projectId_sourceRowId: { projectId, sourceRowId: rowId } },
      select: { id: true, reconciledAt: true, budgetLineId: true },
    });

    const data = {
      category: designation ?? "Sem categoria",
      supplierName: asString(row.getCell(COL.supplierName).value),
      supplierTaxId: asString(row.getCell(COL.supplierTaxId).value),
      country: asString(row.getCell(COL.country).value),
      docNumber: asString(row.getCell(COL.docNumber).value),
      docDate: asDate(row.getCell(COL.docDate).value),
      totalValue: asNumber(row.getCell(COL.totalValue).value),
      vatValue: asNumber(row.getCell(COL.vatValue).value),
      nonDeductibleVat: null,
      eligibleAmount: presentedNet,
      presentedTotal: asNumber(row.getCell(COL.presentedTotal).value),
      presentedVat: asNumber(row.getCell(COL.presentedVat).value),
      presentedEligible: presentedNet,
      paidTotal: asNumber(row.getCell(COL.paidTotal).value),
      paidEligible: asNumber(row.getCell(COL.paidNet).value),
      paymentMethod: asString(row.getCell(COL.paymentMethod).value),
      paymentReference: asString(row.getCell(COL.paymentReference).value),
      paymentDate: asDate(row.getCell(COL.paymentDate).value),
      paymentDocValue: asNumber(row.getCell(COL.paymentDocValue).value),
      ppNumber,
      eligibilityCertified: null,
      obs: null,
      rawSourceRef: orderNumber ? `${orderNumber} - ${designation ?? ""}`.trim() : null,
    };

    // A rubrica a human already confirmed is never overwritten.
    const matchFields = existing?.reconciledAt
      ? {}
      : budgetLineId
        ? {
            budgetLineId,
            matchStatus: "MATCHED" as const,
            matchMethod: "SUGGESTED" as const,
            matchConfidence: 100,
          }
        : {
            budgetLineId: null,
            matchStatus: "UNMATCHED" as const,
            matchMethod: null,
            matchConfidence: null,
          };

    if (existing) {
      await prisma.invoice.update({ where: { id: existing.id }, data: { ...data, ...matchFields } });
      if (existing.budgetLineId) touched.add(existing.budgetLineId);
      summary.updated++;
    } else {
      await prisma.invoice.create({
        data: { projectId, sourceSheet: "Movimentos", sourceRowId: rowId, ...data, ...matchFields },
      });
      summary.created++;
    }
    if (budgetLineId) touched.add(budgetLineId);

    summary.processed++;
    summary.presentedTotal += presentedNet;
    if (ppNumber) {
      summary.byPaymentRequest[ppNumber] = (summary.byPaymentRequest[ppNumber] ?? 0) + presentedNet;
    }
  }

  // The same invoices previously came from the working spreadsheet; leaving
  // both would double-count execution.
  const superseded = await prisma.invoice.findMany({
    where: { projectId, sourceSheet: replacesSourceSheet },
    select: { id: true, budgetLineId: true },
  });
  if (superseded.length > 0) {
    for (const row of superseded) if (row.budgetLineId) touched.add(row.budgetLineId);
    await prisma.invoice.deleteMany({ where: { id: { in: superseded.map((s) => s.id) } } });
    summary.replacedFromWorkingSheet = superseded.length;
  }

  await prisma.$transaction(async (tx) => {
    for (const id of touched) await recomputeBudgetLineExecuted(tx, id);
  });

  summary.presentedTotal = Math.round(summary.presentedTotal * 100) / 100;
  for (const pp of Object.keys(summary.byPaymentRequest)) {
    summary.byPaymentRequest[pp] = Math.round(summary.byPaymentRequest[pp] * 100) / 100;
  }
  return summary;
}
