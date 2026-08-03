import { prisma } from "../../../src/lib/db";
import {
  findBudgetLineCandidates,
  resolveMatchStatus,
  recomputeBudgetLineExecuted,
} from "../../../src/lib/reconciliation";
import { Prisma } from "../../../src/generated/prisma/client";

export interface RawInvoiceRow {
  sourceSheet: string;
  sourceRowId: string;
  projectId: string;
  category: string;
  rawSourceRef: string | null;
  supplierName: string | null;
  supplierTaxId: string | null;
  country: string | null;
  docNumber: string | null;
  docDate: Date | null;
  totalValue: number | null;
  vatValue: number | null;
  nonDeductibleVat: number | null;
  eligibleAmount: number;
  presentedTotal: number | null;
  presentedVat: number | null;
  presentedEligible: number | null;
  paidTotal: number | null;
  paidEligible: number | null;
  paymentMethod: string | null;
  paymentReference: string | null;
  paymentDate: Date | null;
  paymentDocValue: number | null;
  ppNumber: string | null;
  eligibilityCertified: boolean | null;
  obs: string | null;
}

export interface ImportCounters {
  processed: number;
  matched: number;
  unmatched: number;
  ambiguous: number;
}

// Upserts one invoice row keyed on (projectId, sourceRowId): raw fields are
// always refreshed from the source, but a row a human already reconciled
// (reconciledAt set) keeps its budgetLineId/matchStatus untouched — re-running
// the import must never clobber a manual fix.
export async function upsertInvoiceRow(row: RawInvoiceRow, counters: ImportCounters) {
  counters.processed++;

  const existing = await prisma.invoice.findUnique({
    where: { projectId_sourceRowId: { projectId: row.projectId, sourceRowId: row.sourceRowId } },
    select: { id: true, reconciledAt: true, budgetLineId: true },
  });

  const rawFields: Prisma.InvoiceUncheckedUpdateInput = {
    category: row.category,
    rawSourceRef: row.rawSourceRef,
    supplierName: row.supplierName,
    supplierTaxId: row.supplierTaxId,
    country: row.country,
    docNumber: row.docNumber,
    docDate: row.docDate,
    totalValue: row.totalValue,
    vatValue: row.vatValue,
    nonDeductibleVat: row.nonDeductibleVat,
    eligibleAmount: row.eligibleAmount,
    presentedTotal: row.presentedTotal,
    presentedVat: row.presentedVat,
    presentedEligible: row.presentedEligible,
    paidTotal: row.paidTotal,
    paidEligible: row.paidEligible,
    paymentMethod: row.paymentMethod,
    paymentReference: row.paymentReference,
    paymentDate: row.paymentDate,
    paymentDocValue: row.paymentDocValue,
    ppNumber: row.ppNumber,
    eligibilityCertified: row.eligibilityCertified,
    obs: row.obs,
  };

  if (existing?.reconciledAt) {
    // Manually reconciled: refresh raw data only, never touch the link.
    await prisma.invoice.update({ where: { id: existing.id }, data: rawFields });
    if (existing.budgetLineId) counters.matched++;
    return;
  }

  const candidates = await findBudgetLineCandidates({
    projectId: row.projectId,
    rawCategory: row.category,
    rawSourceRef: row.rawSourceRef,
    amount: row.eligibleAmount,
  });
  const resolution = resolveMatchStatus(candidates);

  const matchFields: Prisma.InvoiceUncheckedUpdateInput =
    resolution.status === "MATCHED"
      ? {
          budgetLineId: resolution.best.budgetLineId,
          matchStatus: "MATCHED",
          matchMethod: "SUGGESTED",
          matchConfidence: resolution.best.score,
          matchCandidates: candidates as unknown as Prisma.InputJsonValue,
        }
      : resolution.status === "AMBIGUOUS"
        ? {
            budgetLineId: null,
            matchStatus: "AMBIGUOUS",
            matchMethod: null,
            matchConfidence: null,
            matchCandidates: candidates as unknown as Prisma.InputJsonValue,
          }
        : {
            budgetLineId: null,
            matchStatus: "UNMATCHED",
            matchMethod: null,
            matchConfidence: null,
            matchCandidates: Prisma.JsonNull,
          };

  if (resolution.status === "MATCHED") counters.matched++;
  else if (resolution.status === "AMBIGUOUS") counters.ambiguous++;
  else counters.unmatched++;

  const previousBudgetLineId = existing?.budgetLineId ?? null;
  const nextBudgetLineId =
    resolution.status === "MATCHED" ? resolution.best.budgetLineId : null;

  await prisma.$transaction(async (tx) => {
    if (existing) {
      await tx.invoice.update({
        where: { id: existing.id },
        data: { ...rawFields, ...matchFields, sourceSheet: row.sourceSheet },
      });
    } else {
      await tx.invoice.create({
        data: {
          projectId: row.projectId,
          sourceSheet: row.sourceSheet,
          sourceRowId: row.sourceRowId,
          ...rawFields,
          ...matchFields,
        } as Prisma.InvoiceUncheckedCreateInput,
      });
    }

    for (const budgetLineId of new Set([previousBudgetLineId, nextBudgetLineId].filter(Boolean) as string[])) {
      await recomputeBudgetLineExecuted(tx, budgetLineId);
    }
  });
}
