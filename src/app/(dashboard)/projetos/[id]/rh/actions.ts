"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/authz";
import { recomputeBudgetLineExecuted } from "@/lib/reconciliation";

export async function resolveAllocationMatch(formData: FormData) {
  const user = await requireUser();
  const allocationId = String(formData.get("allocationId") ?? "");
  const budgetLineId = String(formData.get("budgetLineId") ?? "");
  const suggestedScore = formData.get("suggestedScore");

  if (!allocationId || !budgetLineId) throw new Error("Imputação e rubrica são obrigatórias");

  const existing = await prisma.personnelAllocation.findUniqueOrThrow({
    where: { id: allocationId },
    select: { budgetLineId: true, projectId: true },
  });

  await prisma.$transaction(async (tx) => {
    await tx.personnelAllocation.update({
      where: { id: allocationId },
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

  revalidatePath(`/projetos/${existing.projectId}/rh`);
  revalidatePath(`/projetos/${existing.projectId}`);
}

export async function markAllocationNoMatch(formData: FormData) {
  const user = await requireUser();
  const allocationId = String(formData.get("allocationId") ?? "");
  if (!allocationId) throw new Error("Imputação é obrigatória");

  const existing = await prisma.personnelAllocation.findUniqueOrThrow({
    where: { id: allocationId },
    select: { budgetLineId: true, projectId: true },
  });

  await prisma.$transaction(async (tx) => {
    await tx.personnelAllocation.update({
      where: { id: allocationId },
      data: {
        budgetLineId: null,
        matchStatus: "MANUAL_NO_MATCH",
        matchMethod: null,
        matchConfidence: null,
        reconciledById: user.id,
        reconciledAt: new Date(),
      },
    });
    if (existing.budgetLineId) await recomputeBudgetLineExecuted(tx, existing.budgetLineId);
  });

  revalidatePath(`/projetos/${existing.projectId}/rh`);
  revalidatePath(`/projetos/${existing.projectId}`);
}
