"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/authz";
import { recomputeBudgetLineExecuted } from "@/lib/reconciliation";

// Records execution on an FTE-based project (Texia, TexQualis): the eligible
// value is FTE × the project's fixed rate rather than a salary computation.
export async function addFteAllocation(formData: FormData) {
  const user = await requireUser();
  const budgetLineId = String(formData.get("budgetLineId") ?? "");
  const yearMonth = String(formData.get("yearMonth") ?? "").trim();
  const fte = Number(formData.get("fte") ?? 0);
  const personId = String(formData.get("personId") ?? "") || null;
  const obs = String(formData.get("obs") ?? "").trim() || null;

  if (!budgetLineId) throw new Error("Rubrica é obrigatória");
  if (!/^\d{4}-\d{2}$/.test(yearMonth)) throw new Error("Mês inválido (formato AAAA-MM)");
  if (!Number.isFinite(fte) || fte <= 0) throw new Error("FTE tem de ser um número positivo");

  const budgetLine = await prisma.budgetLine.findUniqueOrThrow({
    where: { id: budgetLineId },
    select: { id: true, category: true, projectId: true, project: { select: { fteRate: true } } },
  });
  const fteRate = budgetLine.project.fteRate;
  if (!fteRate) {
    throw new Error("Este projeto não usa taxa fixa por FTE");
  }

  const person = personId
    ? await prisma.person.findUnique({ where: { id: personId }, select: { name: true } })
    : null;

  await prisma.$transaction(async (tx) => {
    await tx.personnelAllocation.create({
      data: {
        projectId: budgetLine.projectId,
        budgetLineId: budgetLine.id,
        personId,
        rawPersonLabel: person?.name ?? budgetLine.category,
        category: budgetLine.category,
        yearMonth,
        eligibleBaseSalary: 0,
        allocationPercent: 0,
        socialSecurityRate: 0,
        fte,
        eligibleValue: Number(fteRate) * fte,
        obs,
        matchStatus: "MATCHED",
        matchMethod: "MANUAL",
        reconciledById: user.id,
        reconciledAt: new Date(),
        sourceSheet: "manual",
        sourceRowId: `manual:${randomUUID()}`,
      },
    });
    await recomputeBudgetLineExecuted(tx, budgetLine.id);
  });

  revalidatePath(`/projetos/${budgetLine.projectId}/rh`);
  revalidatePath(`/projetos/${budgetLine.projectId}`);
}

export async function deleteAllocation(formData: FormData) {
  await requireUser();
  const allocationId = String(formData.get("allocationId") ?? "");
  if (!allocationId) throw new Error("Imputação é obrigatória");

  const allocation = await prisma.personnelAllocation.findUniqueOrThrow({
    where: { id: allocationId },
    select: { budgetLineId: true, projectId: true, sourceSheet: true },
  });
  // Imported rows would simply come back on the next import; only manually
  // entered execution can be deleted here.
  if (allocation.sourceSheet !== "manual") {
    throw new Error("Só é possível remover imputações introduzidas manualmente");
  }

  await prisma.$transaction(async (tx) => {
    await tx.personnelAllocation.delete({ where: { id: allocationId } });
    if (allocation.budgetLineId) await recomputeBudgetLineExecuted(tx, allocation.budgetLineId);
  });

  revalidatePath(`/projetos/${allocation.projectId}/rh`);
  revalidatePath(`/projetos/${allocation.projectId}`);
}

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
