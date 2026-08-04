import { prisma } from "../../src/lib/db";
import { loadWorkbook, getSheet, asString, asNumber, asDate, sourceRowId } from "./lib/workbook";

// Money actually received, from the "Incomes - Grants" sheet — a bank-statement
// extract with one row per transfer. The sheet names the project in free text
// and says nothing about which payment request a transfer answers, so the
// project is resolved by that text and the request, where possible, by matching
// the amount against what a request records as paid.
const SHEET = "Incomes - Grants";
const COL = { date: 2, amount: 3, description: 4, bankDescription: 5, currency: 6 } as const;

// The statement's own spelling of each project. Anything not listed here is a
// grant for something outside this platform's scope (Horizonte 2020, Indústria
// 4.0) and is reported rather than guessed at.
const PROJECT_BY_DESCRIPTION: Record<string, string> = {
  textpact: "TEXPACT",
  "texp@ct": "TEXPACT",
  produtech: "PRODUTECH",
  texia: "TEXIA",
  texqualis: "TEXQUALIS",
  "defect free": "DEFECT_FREE",
  internacionalização: "INTERNACIONALIZACAO",
  internacionalizacao: "INTERNACIONALIZACAO",
};

export interface ReceiptsImportSummary {
  processed: number;
  created: number;
  updated: number;
  total: number;
  byProject: Record<string, number>;
  linkedToRequest: number;
  // Descriptions that name no project this platform tracks, with their totals.
  outOfScope: Record<string, number>;
}

function resolveProjectCode(description: string): string | null {
  const text = description.toLowerCase();
  for (const [needle, code] of Object.entries(PROJECT_BY_DESCRIPTION)) {
    if (text.includes(needle)) return code;
  }
  return null;
}

export async function importReceipts(
  workbookPath: string,
  projectIds: Record<string, string>,
): Promise<ReceiptsImportSummary> {
  const sheet = getSheet(await loadWorkbook(workbookPath), SHEET);

  // What a request was paid is the only bridge between a bank transfer and the
  // request it settles. An amount matching exactly one request of that project
  // is a safe link; an amount matching several is not, and stays unlinked.
  const requests = await prisma.paymentRequest.findMany({
    where: { paidAmount: { not: null } },
    select: { id: true, projectId: true, paidAmount: true },
  });
  const requestsByPaidAmount = new Map<string, string[]>();
  for (const request of requests) {
    const key = `${request.projectId}|${Number(request.paidAmount).toFixed(2)}`;
    requestsByPaidAmount.set(key, [...(requestsByPaidAmount.get(key) ?? []), request.id]);
  }

  const summary: ReceiptsImportSummary = {
    processed: 0,
    created: 0,
    updated: 0,
    total: 0,
    byProject: {},
    linkedToRequest: 0,
    outOfScope: {},
  };

  for (let r = 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const receivedDate = asDate(row.getCell(COL.date).value);
    const amount = asNumber(row.getCell(COL.amount).value);
    const description = asString(row.getCell(COL.description).value);
    // The sheet ends with a Total row and several summary blocks; a row is only
    // a transfer if it has all three of a date, an amount and a description.
    if (!receivedDate || amount === null || !description) continue;

    const code = resolveProjectCode(description);
    if (!code || !projectIds[code]) {
      summary.outOfScope[description] = (summary.outOfScope[description] ?? 0) + amount;
      continue;
    }
    const projectId = projectIds[code];

    const key = `${projectId}|${amount.toFixed(2)}`;
    const candidates = requestsByPaidAmount.get(key) ?? [];
    const paymentRequestId = candidates.length === 1 ? candidates[0] : null;
    if (paymentRequestId) summary.linkedToRequest++;

    // The statement has no transaction id, so the natural key is the transfer
    // itself: same project, date and amount is the same money.
    const rowId = sourceRowId(SHEET, code, receivedDate.toISOString().slice(0, 10), amount);
    const existing = await prisma.receipt.findUnique({
      where: { projectId_sourceRowId: { projectId, sourceRowId: rowId } },
      select: { id: true, paymentRequestId: true },
    });

    const data = {
      receivedDate,
      amount,
      description,
      bankDescription: asString(row.getCell(COL.bankDescription).value),
      currency: asString(row.getCell(COL.currency).value) ?? "EUR",
    };

    if (existing) {
      await prisma.receipt.update({
        where: { id: existing.id },
        // A link someone set by hand in the app is not overwritten by a re-run.
        data: existing.paymentRequestId ? data : { ...data, paymentRequestId },
      });
      summary.updated++;
    } else {
      await prisma.receipt.create({
        data: { projectId, sourceSheet: SHEET, sourceRowId: rowId, paymentRequestId, ...data },
      });
      summary.created++;
    }

    summary.processed++;
    summary.total += amount;
    summary.byProject[code] = (summary.byProject[code] ?? 0) + amount;
  }

  summary.total = Math.round(summary.total * 100) / 100;
  for (const k of Object.keys(summary.byProject)) {
    summary.byProject[k] = Math.round(summary.byProject[k] * 100) / 100;
  }
  for (const k of Object.keys(summary.outOfScope)) {
    summary.outOfScope[k] = Math.round(summary.outOfScope[k] * 100) / 100;
  }
  return summary;
}
