import { existsSync } from "node:fs";
import { prisma } from "../../src/lib/db";
import { readCsv } from "./lib/csv";
import { sourceRowId } from "./lib/workbook";
import { recomputeBudgetLineExecuted } from "../../src/lib/reconciliation";

// Travel declared to the funder (the portal's "Deslocações" screen). These are
// per-diem style costs with no supplier invoice, so they are absent from the
// "Lista geral de movimentos" export and would otherwise leave the travel
// rubricas short of what was declared.
//
// They are stored as invoices because that is what the model calls a declared
// expense row: same rubrica link, same payment request, same execution rollup.
// The only difference is that supplier and document number are empty.
export interface DeslocacoesImportSummary {
  processed: number;
  created: number;
  updated: number;
  total: number;
  byPaymentRequest: Record<string, number>;
  byOrderNumber: Record<string, number>;
}

const TRAVEL_CATEGORY = "Viagens e estadas no estrangeiro (i)";

export async function importDeslocacoes(
  csvPath: string,
  projectId: string,
): Promise<DeslocacoesImportSummary | null> {
  if (!existsSync(csvPath)) return null;

  const rows = readCsv(csvPath);
  const budgetLines = await prisma.budgetLine.findMany({
    where: { projectId, category: TRAVEL_CATEGORY },
    select: { id: true, orderNumber: true, declaredExecuted: true },
  });
  const byOrderNumber = new Map(budgetLines.map((l) => [l.orderNumber, l]));

  const summary: DeslocacoesImportSummary = {
    processed: 0,
    created: 0,
    updated: 0,
    total: 0,
    byPaymentRequest: {},
    byOrderNumber: {},
  };
  const touched = new Set<string>();

  for (const row of rows) {
    const amount = Number(row.amount);
    if (!Number.isFinite(amount)) {
      throw new Error(`${csvPath}: deslocação ${row.sourceId} sem valor numérico ("${row.amount}")`);
    }
    const line = byOrderNumber.get(row.orderNumber);
    if (!line) {
      throw new Error(
        `${csvPath}: deslocação ${row.sourceId} aponta para a ordem ${row.orderNumber}, ` +
          `que não existe como rubrica de viagens deste projeto.`,
      );
    }

    const rowId = sourceRowId("Deslocacoes", row.sourceId);
    const existing = await prisma.invoice.findUnique({
      where: { projectId_sourceRowId: { projectId, sourceRowId: rowId } },
      select: { id: true, reconciledAt: true, budgetLineId: true },
    });

    const data = {
      category: TRAVEL_CATEGORY,
      docDate: new Date(`${row.date}T00:00:00Z`),
      eligibleAmount: amount,
      presentedEligible: amount,
      presentedTotal: amount,
      ppNumber: row.ppNumber || null,
      obs: [
        row.origin && row.destination ? `${row.origin} → ${row.destination}` : null,
        row.people ? `${row.people} pessoa(s)` : null,
        row.days ? `${row.days} dia(s)` : null,
        row.description || null,
      ]
        .filter(Boolean)
        .join(" · "),
      rawSourceRef: `${row.orderNumber} - ${TRAVEL_CATEGORY}`,
    };

    const matchFields = existing?.reconciledAt
      ? {}
      : {
          budgetLineId: line.id,
          matchStatus: "MATCHED" as const,
          matchMethod: "SUGGESTED" as const,
          matchConfidence: 100,
        };

    if (existing) {
      await prisma.invoice.update({ where: { id: existing.id }, data: { ...data, ...matchFields } });
      if (existing.budgetLineId) touched.add(existing.budgetLineId);
      summary.updated++;
    } else {
      await prisma.invoice.create({
        data: { projectId, sourceSheet: "Deslocacoes", sourceRowId: rowId, ...data, ...matchFields },
      });
      summary.created++;
    }
    touched.add(line.id);

    summary.processed++;
    summary.total += amount;
    if (row.ppNumber) {
      summary.byPaymentRequest[row.ppNumber] = (summary.byPaymentRequest[row.ppNumber] ?? 0) + amount;
    }
    summary.byOrderNumber[row.orderNumber] = (summary.byOrderNumber[row.orderNumber] ?? 0) + amount;
  }

  await prisma.$transaction(async (tx) => {
    for (const id of touched) await recomputeBudgetLineExecuted(tx, id);
  });

  // Each travel rubrica must now hold exactly what the funder's Quadro says was
  // declared on it. This is the whole reason to transcribe these rows by hand,
  // so a transcription that does not close the gap must fail loudly.
  const after = await prisma.budgetLine.findMany({
    where: { projectId, category: TRAVEL_CATEGORY, declaredExecuted: { not: null } },
    select: { orderNumber: true, declaredExecuted: true, executedAmount: true },
  });
  const off = after
    .filter((l) => Math.abs(Number(l.executedAmount) - Number(l.declaredExecuted)) > 0.01)
    .map(
      (l) =>
        `ordem ${l.orderNumber}: declarado ${Number(l.declaredExecuted).toFixed(2)} €, ` +
        `registado ${Number(l.executedAmount).toFixed(2)} €`,
    );
  if (off.length > 0) {
    throw new Error(
      `${csvPath}: as viagens registadas não fecham com o Quadro de Investimentos:\n  ` +
        off.join("\n  "),
    );
  }

  summary.total = Math.round(summary.total * 100) / 100;
  return summary;
}
