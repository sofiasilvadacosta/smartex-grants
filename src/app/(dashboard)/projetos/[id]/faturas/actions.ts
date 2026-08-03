"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/authz";
import { recomputeBudgetLineExecuted } from "@/lib/reconciliation";

export async function resolveInvoiceMatch(formData: FormData) {
  const user = await requireUser();
  const invoiceId = String(formData.get("invoiceId") ?? "");
  const budgetLineId = String(formData.get("budgetLineId") ?? "");
  const suggestedScore = formData.get("suggestedScore");

  if (!invoiceId || !budgetLineId) throw new Error("Fatura e rubrica são obrigatórias");

  const existing = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    select: { budgetLineId: true, projectId: true },
  });

  await prisma.$transaction(async (tx) => {
    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        budgetLineId,
        matchStatus: "MATCHED",
        matchMethod: suggestedScore ? "SUGGESTED" : "MANUAL",
        matchConfidence: suggestedScore ? Number(suggestedScore) : null,
        reconciledById: user.id,
        reconciledAt: new Date(),
      },
    });
    for (const id of new Set([existing.budgetLineId, budgetLineId].filter(Boolean) as string[])) {
      await recomputeBudgetLineExecuted(tx, id);
    }
  });

  revalidatePath(`/projetos/${existing.projectId}/faturas`);
  revalidatePath(`/projetos/${existing.projectId}`);
}

export async function markInvoiceNoMatch(formData: FormData) {
  const user = await requireUser();
  const invoiceId = String(formData.get("invoiceId") ?? "");
  if (!invoiceId) throw new Error("Fatura é obrigatória");

  const existing = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    select: { budgetLineId: true, projectId: true },
  });

  await prisma.$transaction(async (tx) => {
    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        budgetLineId: null,
        matchStatus: "MANUAL_NO_MATCH",
        matchMethod: null,
        matchConfidence: null,
        reconciledById: user.id,
        reconciledAt: new Date(),
      },
    });
    if (existing.budgetLineId) {
      await recomputeBudgetLineExecuted(tx, existing.budgetLineId);
    }
  });

  revalidatePath(`/projetos/${existing.projectId}/faturas`);
  revalidatePath(`/projetos/${existing.projectId}`);
}
