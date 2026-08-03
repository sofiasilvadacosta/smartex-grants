import { prisma } from "../../../src/lib/db";
import { recomputeBudgetLineExecuted } from "../../../src/lib/reconciliation";

export interface PruneResult {
  deleted: number;
  keptReconciled: string[];
}

// Rows that a previous import created but the current source no longer
// produces (a corrected sheet, or — as happened with PP_Internacionalização —
// rows a buggy mapping should never have created). Without this they linger
// forever and silently inflate execution totals.
//
// Rows a human already reconciled are never deleted: that decision may be the
// only record of a judgement call, so they are reported for manual review
// instead.
export async function pruneStaleInvoices(
  projectId: string,
  sourceSheet: string,
  seenRowIds: string[],
): Promise<PruneResult> {
  const stale = await prisma.invoice.findMany({
    where: { projectId, sourceSheet, sourceRowId: { notIn: seenRowIds } },
    select: { id: true, reconciledAt: true, budgetLineId: true, supplierName: true, docNumber: true },
  });
  if (stale.length === 0) return { deleted: 0, keptReconciled: [] };

  const deletable = stale.filter((row) => !row.reconciledAt);
  const keptReconciled = stale
    .filter((row) => row.reconciledAt)
    .map((row) => `${row.supplierName ?? "(sem fornecedor)"} / ${row.docNumber ?? "(sem nº)"}`);

  const affectedBudgetLineIds = [
    ...new Set(deletable.map((row) => row.budgetLineId).filter(Boolean) as string[]),
  ];

  await prisma.$transaction(async (tx) => {
    await tx.invoice.deleteMany({ where: { id: { in: deletable.map((row) => row.id) } } });
    for (const budgetLineId of affectedBudgetLineIds) {
      await recomputeBudgetLineExecuted(tx, budgetLineId);
    }
  });

  return { deleted: deletable.length, keptReconciled };
}
