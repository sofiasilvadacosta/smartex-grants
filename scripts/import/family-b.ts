import {
  loadWorkbook,
  getSheet,
  findHeaderRow,
  asString,
  asNumber,
  asDate,
  sourceRowId,
} from "./lib/workbook";
import { upsertInvoiceRow, type ImportCounters, type RawInvoiceRow } from "./lib/upsert-invoice";

// The newer "PP_<Project>" sheets (Internacionalização, Defect Free) repeat
// header names 3x ("Valor total"/"Valor s/ IVA"/"Valor IVA" for the
// apresentada/paga/documento-de-suporte value groups), so unlike family-a.ts
// they must be read by fixed column position, not name lookup — verified
// against a full header dump of each sheet (see task notes / plan).
interface ColumnMap {
  sheetName: string;
  projectCode: string;
  tipoInvestimento: number | null;
  ppNumber: number;
  country: number;
  supplierTaxId: number;
  supplierName: number;
  docNumber: number;
  docDate: number;
  totalValue: number;
  vatValue: number;
  orderNumber: number;
  designacao: number;
  presentedTotal: number;
  presentedEligible: number;
  presentedVat: number;
  paidTotal: number;
  paidEligible: number;
  paymentMethod: number;
  paymentReference: number;
  paymentDate: number;
  paymentDocValue: number;
}

const SHEETS: ColumnMap[] = [
  {
    sheetName: "PP_Internacionalização",
    projectCode: "INTERNACIONALIZACAO",
    tipoInvestimento: null,
    ppNumber: 3,
    country: 6,
    supplierTaxId: 7,
    supplierName: 8,
    docNumber: 10,
    docDate: 11,
    totalValue: 12,
    vatValue: 14,
    orderNumber: 15,
    designacao: 16,
    presentedTotal: 18,
    presentedEligible: 19,
    presentedVat: 20,
    paidTotal: 21,
    paidEligible: 22,
    paymentMethod: 25,
    paymentReference: 26,
    paymentDate: 27,
    paymentDocValue: 28,
  },
  {
    sheetName: "PP Defect Free",
    projectCode: "DEFECT_FREE",
    tipoInvestimento: 2,
    ppNumber: 4,
    country: 7,
    supplierTaxId: 8,
    supplierName: 9,
    docNumber: 11,
    docDate: 12,
    totalValue: 13,
    vatValue: 15,
    orderNumber: 16,
    designacao: 17,
    presentedTotal: 19,
    presentedEligible: 20,
    presentedVat: 21,
    paidTotal: 22,
    paidEligible: 23,
    paymentMethod: 26,
    paymentReference: 27,
    paymentDate: 28,
    paymentDocValue: 29,
  },
];

export async function importFamilyB(workbookPath: string, projectIds: Record<string, string>) {
  const workbook = await loadWorkbook(workbookPath);
  const summary: Record<string, unknown> = {};

  for (const map of SHEETS) {
    const projectId = projectIds[map.projectCode];
    if (!projectId) continue;

    const sheet = getSheet(workbook, map.sheetName);
    const headerRow = findHeaderRow(sheet, 4); // these sheets have 2 blank/group-label rows before the field-name row

    const counters: ImportCounters = { processed: 0, matched: 0, unmatched: 0, ambiguous: 0 };

    for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      const supplierName = asString(row.getCell(map.supplierName).value);
      const presentedTotal = asNumber(row.getCell(map.presentedTotal).value);
      const presentedEligible = asNumber(row.getCell(map.presentedEligible).value);
      if (!supplierName && presentedTotal == null) continue; // blank/footer row

      const docNumber = asString(row.getCell(map.docNumber).value);
      const docDate = asDate(row.getCell(map.docDate).value);
      const orderNumber = asString(row.getCell(map.orderNumber).value);
      const designacao = asString(row.getCell(map.designacao).value);
      const tipoInvestimento = map.tipoInvestimento ? asString(row.getCell(map.tipoInvestimento).value) : null;

      const raw: RawInvoiceRow = {
        sourceSheet: map.sheetName,
        sourceRowId: sourceRowId(map.sheetName, r, docNumber, supplierName, docDate?.toISOString()),
        projectId,
        category: tipoInvestimento ?? designacao ?? "Sem categoria",
        rawSourceRef: [orderNumber, designacao].filter(Boolean).join(" - ") || null,
        supplierName,
        supplierTaxId: asString(row.getCell(map.supplierTaxId).value),
        country: asString(row.getCell(map.country).value),
        docNumber,
        docDate,
        totalValue: asNumber(row.getCell(map.totalValue).value),
        vatValue: asNumber(row.getCell(map.vatValue).value),
        nonDeductibleVat: null,
        eligibleAmount: presentedEligible ?? presentedTotal ?? 0,
        presentedTotal,
        presentedVat: asNumber(row.getCell(map.presentedVat).value),
        presentedEligible,
        paidTotal: asNumber(row.getCell(map.paidTotal).value),
        paidEligible: asNumber(row.getCell(map.paidEligible).value),
        paymentMethod: asString(row.getCell(map.paymentMethod).value),
        paymentReference: asString(row.getCell(map.paymentReference).value),
        paymentDate: asDate(row.getCell(map.paymentDate).value),
        paymentDocValue: asNumber(row.getCell(map.paymentDocValue).value),
        ppNumber: asString(row.getCell(map.ppNumber).value),
        eligibilityCertified: null,
        obs: null,
      };

      await upsertInvoiceRow(raw, counters);
    }

    summary[map.projectCode] = { invoices: counters };
  }

  return summary;
}

// Also referenced by index.ts to warn the user which real, financially-active
// projects have NO automated import yet (structurally different sheets that
// need a dedicated look rather than a guessed mapping — see plan Fase 4).
export const PENDING_RECONCILIATION_PROJECTS = ["RHAQ", "TEXIA", "TEXQUALIS"] as const;
