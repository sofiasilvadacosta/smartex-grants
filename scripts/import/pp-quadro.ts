import { existsSync } from "node:fs";
import { prisma } from "../../src/lib/db";
import { recomputeBudgetLineExecuted } from "../../src/lib/reconciliation";
import { readCsv } from "./lib/csv";

// The approved budget for projects whose "Quadro de Investimentos" only exists
// in the funder's payment-request PDF, converted to CSV by
// scripts/import/extract-pp-quadro.py. One budget line per "Nº ordem" — the unit
// the funder itself approves and reports against.
interface QuadroRow {
  orderNumber: string;
  activity: string;
  classification: string;
  endDate: string;
  approved: number;
  // Null when the portal's print clipped the value's last digit — see
  // extract-pp-quadro.py. A clipped figure must not become a comparison
  // baseline, so it is absent rather than approximated.
  declaredExecuted: number | null;
}

export interface QuadroImportSummary {
  budgetLinesCreated: number;
  budgetLinesUpdated: number;
  approvedTotal: number;
  declaredExecutedTotal: number;
  invoicesLinkedByOrderNumber: number;
  invoicesStillUnmatched: number;
  // Lines whose declared execution the PDF clipped and so could not be read.
  declaredExecutedUnreadable: number;
  // Budget lines carrying an order number the current CSV no longer contains.
  // Reported rather than deleted: they may already have execution linked or be
  // a line entered by hand, so removing them is a human decision.
  staleOrderNumbers: string[];
}

function optionalNumber(text: string): number | null {
  if (!text.trim()) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function parseCsv(path: string): QuadroRow[] {
  return readCsv(path).map((row) => ({
    orderNumber: row.orderNumber,
    activity: row.activity,
    classification: row.classification,
    endDate: row.endDate,
    approved: Number(row.approved),
    declaredExecuted: optionalNumber(row.declaredExecuted ?? ""),
  }));
}

export async function importQuadroInvestimentos(
  csvPath: string,
  projectId: string,
): Promise<QuadroImportSummary | null> {
  if (!existsSync(csvPath)) return null;

  const rows = parseCsv(csvPath);
  let created = 0;
  let updated = 0;

  for (const row of rows) {
    // The year distinguishes the funder's annual tranches of the same
    // activity/classification pair, so it belongs in the unique key.
    const trlPhase = row.endDate ? row.endDate.slice(0, 4) : "";
    // The funder's "Nº ordem" identifies the line on its own, so look it up by
    // that alone. Keying on activity and classification too would make a
    // re-read that corrects either of them create a second line for the same
    // approved budget instead of updating the existing one.
    const existing = row.orderNumber
      ? await prisma.budgetLine.findFirst({
          where: { projectId, orderNumber: row.orderNumber },
        })
      : await prisma.budgetLine.findUnique({
          where: {
            projectId_activity_category_trlPhase_orderNumber: {
              projectId,
              activity: row.activity,
              category: row.classification,
              trlPhase,
              orderNumber: "",
            },
          },
        });

    if (existing) {
      if (Number(existing.eligibleCost) !== row.approved) {
        await prisma.budgetChangeLog.create({
          data: {
            budgetLineId: existing.id,
            changeType: "UPDATE",
            changedField: "eligibleCost",
            oldValue: String(existing.eligibleCost),
            newValue: String(row.approved),
            reason: "Reimportação do Quadro de Investimentos do pedido de pagamento",
          },
        });
      }
      await prisma.budgetLine.update({
        where: { id: existing.id },
        data: {
          activity: row.activity,
          category: row.classification,
          trlPhase,
          orderNumber: row.orderNumber,
          eligibleCost: row.approved,
          declaredExecuted: row.declaredExecuted,
        },
      });
      updated++;
    } else {
      const line = await prisma.budgetLine.create({
        data: {
          projectId,
          activity: row.activity,
          category: row.classification,
          trlPhase,
          orderNumber: row.orderNumber,
          eligibleCost: row.approved,
          declaredExecuted: row.declaredExecuted,
          financingAmount: 0,
        },
      });
      await prisma.budgetChangeLog.create({
        data: {
          budgetLineId: line.id,
          changeType: "CREATE",
          newValue: JSON.stringify({ approved: row.approved }),
          reason: "Importação do Quadro de Investimentos do pedido de pagamento",
        },
      });
      created++;
    }
  }

  // Invoices already carry the funder's "Nº ordem" in rawSourceRef, so link
  // them exactly. Rows a human already reconciled are left alone.
  const byOrderNumber = new Map(
    (
      await prisma.budgetLine.findMany({
        where: { projectId, orderNumber: { not: "" } },
        select: { id: true, orderNumber: true },
      })
    ).map((line) => [line.orderNumber, line.id]),
  );

  const invoices = await prisma.invoice.findMany({
    where: { projectId, reconciledAt: null },
    select: { id: true, rawSourceRef: true, budgetLineId: true },
  });

  let linked = 0;
  const touchedBudgetLines = new Set<string>();

  for (const invoice of invoices) {
    const orderNumber = /^\s*(\d+)\s*[-/]/.exec(invoice.rawSourceRef ?? "")?.[1];
    const budgetLineId = orderNumber ? byOrderNumber.get(orderNumber) : undefined;
    if (!budgetLineId) continue;

    await prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        budgetLineId,
        matchStatus: "MATCHED",
        matchMethod: "SUGGESTED",
        matchConfidence: 100,
      },
    });
    if (invoice.budgetLineId) touchedBudgetLines.add(invoice.budgetLineId);
    touchedBudgetLines.add(budgetLineId);
    linked++;
  }

  await prisma.$transaction(async (tx) => {
    for (const id of touchedBudgetLines) await recomputeBudgetLineExecuted(tx, id);
  });

  const stillUnmatched = await prisma.invoice.count({
    where: { projectId, matchStatus: { in: ["UNMATCHED", "AMBIGUOUS"] } },
  });

  const expected = new Set(rows.map((r) => r.orderNumber));
  const staleOrderNumbers = [...byOrderNumber.keys()].filter((n) => !expected.has(n)).sort();

  return {
    budgetLinesCreated: created,
    budgetLinesUpdated: updated,
    approvedTotal: Math.round(rows.reduce((s, r) => s + r.approved, 0) * 100) / 100,
    declaredExecutedTotal:
      Math.round(rows.reduce((s, r) => s + (r.declaredExecuted ?? 0), 0) * 100) / 100,
    declaredExecutedUnreadable: rows.filter((r) => r.declaredExecuted === null).length,
    invoicesLinkedByOrderNumber: linked,
    invoicesStillUnmatched: stillUnmatched,
    staleOrderNumbers,
  };
}
